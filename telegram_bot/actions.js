// failas: telegram_bot/actions.js
// Paskirtis: Perkelti čia visų mygtukų paspaudimų (bot.action(...)) logiką.

import { ADMIN_ID, CONFIG_KEYS, MAX_SUBACCOUNTS_NUM } from '../config.js';
import { redisClient, tradingQueue } from '../services/redis.js';
import { sendTelegramMessage } from '../services/telegram.js';
import {
    getAccountBalance,
    getDetailedPositionInfo,
    analyzeRedisSync,
    getSubAccountBalances,
    executeInternalTransfer
} from '../utils.js';
import { initializeConfig } from '../app-setup.js';
import { MAIN_MENU, SUBMENUS, SessionManager } from './ux_helpers.js';

// Middleware, tikrinantis, ar vartotojas yra administratorius.
const isAdmin = (ctx, next) => {
    if (ctx.from.id === ADMIN_ID) {
        return next();
    }
    return ctx.answerCbQuery('🔒 Ši funkcija prieinama tik administratoriui.', { show_alert: true });
};

// Laikinas kintamasis, kol neturime geresnio sprendimo startavimo laikui
const startTime = new Date();

export const registerActions = (bot) => {

    // =================================================================
    // === MENIU NAVIGACIJA ============================================
    // =================================================================

    // Universalus meniu handleris
    bot.action(/^menu_(.+)$/, isAdmin, async (ctx) => {
        const menuType = ctx.match[1];
        const menu = SUBMENUS[menuType];

        if (menu) {
            await ctx.editMessageText(menu.text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: menu.keyboard }
            });

            const sessionManager = new SessionManager(redisClient);
            await sessionManager.updateUserSession(ctx.from.id, {
                lastActivity: new Date(),
                currentMenu: menuType
            });
        }
        ctx.answerCbQuery();
    });

    // Grįžimo navigacija
    bot.action(/^back_(.+)$/, isAdmin, async (ctx) => {
        const target = ctx.match[1];

        if (target === 'main') {
            await ctx.editMessageText(MAIN_MENU.text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: MAIN_MENU.keyboard }
            });
        } else if (SUBMENUS[target]) {
            const menu = SUBMENUS[target];
            await ctx.editMessageText(menu.text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: menu.keyboard }
            });
        }
        ctx.answerCbQuery();
    });
    
    // Mygtukas "not implemented"
    bot.action('not_implemented', isAdmin, async (ctx) => {
        await ctx.answerCbQuery('ℹ️ Ši funkcija dar kuriama.', { show_alert: true });
    });

    // =================================================================
    // === APŽVALGOS (OVERVIEW) VEIKSMAI ===============================
    // =================================================================

    bot.action('overview_detailed', isAdmin, async (ctx) => {
        await ctx.answerCbQuery('🔍 Analizuoju prekybos būklę...');
        await ctx.editMessageText('🔍 Analizuoju prekybos būklę... Prašome palaukti.');

        let responseText = '';
        let totalEquity = 0;
        let totalUnrealisedPnl = 0;
        let totalActivePositions = 0;
        const unmanagedPositions = [];
        const unprotectedPositions = [];

        for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
            const client = bybitClients.get(i);
            if (!client) continue;

            try {
                const balance = await getAccountBalance(client);
                if (balance) {
                    totalEquity += balance.equity;
                    totalUnrealisedPnl += balance.unrealisedPnl;
                }

                const positions = await getDetailedPositionInfo(client, i);

                if (positions.length > 0) {
                    const pnlAccount = positions.reduce((sum, pos) => sum + pos.unrealisedPnl, 0);
                    const pnlAccountPercent = balance && balance.equity > 0 ? (pnlAccount / balance.equity) * 100 : 0;
                    const pnlSign = pnlAccount >= 0 ? '+' : '';

                    responseText += `*Sub-${i} | $${balance?.equity?.toFixed(2) || 'N/A'} (${pnlSign}${pnlAccount.toFixed(2)} / ${pnlSign}${pnlAccountPercent.toFixed(1)}%)*\n`;

                    for (const pos of positions) {
                        totalActivePositions++;
                        const managedIcon = pos.isManaged ? '✅' : '🚨';
                        const protectionIcon = pos.hasStopLoss && pos.hasTakeProfit ? '🛡️' : '⚠️';
                        const sideIcon = pos.side === 'Buy' ? '📈' : '📉';

                        const pnlSignPos = pos.unrealisedPnl >= 0 ? '+' : '';
                        const pnlText = `${pnlSignPos}${pos.unrealisedPnl.toFixed(2)} (${pnlSignPos}${pos.pnlPercent.toFixed(1)}%)`;

                        responseText += `  ${managedIcon}${protectionIcon} ${sideIcon} *${pos.symbol}* | P/L: \`${pnlText}\`\n`;
                        responseText += `    Entry: \`${pos.avgPrice}\` | SL: \`${pos.stopLoss === '0' ? 'Nėra' : pos.stopLoss}\`\n`;

                        if (!pos.isManaged) unmanagedPositions.push(`Sub-${i}: ${pos.symbol} (${pos.side})`);
                        if (!pos.hasStopLoss) unprotectedPositions.push(`Sub-${i}: ${pos.symbol} (trūksta SL)`);
                    }
                    responseText += '\n';
                } else if (balance && balance.equity > 0) {
                    responseText += `*Sub-${i} | $${balance.equity.toFixed(2)}* | \`ℹ️ Laisva\`\n\n`;
                }
            } catch (e) {
                responseText += `*Sub-${i}* | ❌ Klaida: ${e.message}\n\n`;
            }
        }

        let header = `*📊 Bendra Prekybos Apžvalga*\n\n`;
        const totalPnlSign = totalUnrealisedPnl >= 0 ? '+' : '';
        const totalPnlPercent = totalEquity > 0 ? (totalUnrealisedPnl / totalEquity) * 100 : 0;

        header += `*Bendras Kapitalas:* \`$${totalEquity.toFixed(2)}\`\n`;
        header += `*Nerealizuotas P/L:* \`${totalPnlSign}${totalUnrealisedPnl.toFixed(2)} (${isNaN(totalPnlPercent) ? '0.0' : totalPnlPercent.toFixed(1)}%)\`\n`;
        header += `*Aktyvios Pozicijos:* \`${totalActivePositions}\`\n\n`;

        if (unmanagedPositions.length > 0 || unprotectedPositions.length > 0) {
            header += `*📋 Problemų Santrauka*\n`;
            if (unmanagedPositions.length > 0) header += `*🚨 Nevaldomos (${unmanagedPositions.length}):* ${unmanagedPositions.join(', ')}\n`;
            if (unprotectedPositions.length > 0) header += `*⚠️ Neapsaugotos (${unprotectedPositions.length}):* ${unprotectedPositions.join(', ')}\n\n`;
        }

        await ctx.editMessageText(header + responseText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔄 Atnaujinti', callback_data: 'overview_detailed' }], [{ text: '🔙 Atgal', callback_data: 'back_overview' }]] }
        });
    });

    bot.action('overview_issues', isAdmin, async (ctx) => {
        await ctx.answerCbQuery('🔍 Ieškau problemų...');
        await ctx.editMessageText('🔍 Ieškau problemų... Prašome palaukti.');
    
        const syncReport = await analyzeRedisSync();
        let responseText = '*🚨 Problemų Ataskaita*\n\n';
        let hasIssues = false;
    
        if (syncReport.unmanagedBybitPositions.length > 0) {
            hasIssues = true;
            responseText += `*🚨 Nevaldomos Bybit Pozicijos (${syncReport.unmanagedBybitPositions.length}):*\n`;
            syncReport.unmanagedBybitPositions.forEach(p => {
                responseText += `  • \`Sub-${p.subAccount}: ${p.symbol} (${p.side})\`\n`;
            });
            responseText += '\n';
        }
    
        if (syncReport.syncIssues.length > 0) {
            hasIssues = true;
            responseText += `*👻 Redis "Vaiduokliai" / Neatitikimai (${syncReport.syncIssues.length}):*\n`;
            syncReport.syncIssues.forEach(issue => {
                responseText += `  • \`Sub-${issue.subAccount}: ${issue.symbol}\` (${issue.type})\n`;
            });
            responseText += '\n';
        }
    
        if (syncReport.orphanedRedisEntries.length > 0) {
            hasIssues = true;
            responseText += `*🗑️ Pažeisti Redis Įrašai (${syncReport.orphanedRedisEntries.length}):*\n`;
            syncReport.orphanedRedisEntries.forEach(entry => {
                responseText += `  • \`TradeID: ${entry.tradeId}\`\n`;
            });
            responseText += '\n';
        }
    
        if (!hasIssues) {
            responseText += '✅ Jokių problemų nerasta. Sistema veikia sinchronizuotai.';
        }
    
        await ctx.editMessageText(responseText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔄 Atnaujinti', callback_data: 'overview_issues' }], [{ text: '🔙 Atgal', callback_data: 'back_overview' }]] }
        });
    });

    // =================================================================
    // === FINANSŲ (FINANCE) VEIKSMAI ==================================
    // =================================================================

    bot.action('finance_balances', isAdmin, async (ctx) => {
        await ctx.answerCbQuery('💰 Gaunami balansai...');
        await ctx.editMessageText('💰 Gaunami sub-sąskaitų balansai...');

        try {
            const balances = await getSubAccountBalances(true);
            if (balances.length < 1) {
                return ctx.editMessageText('❌ Nerasta jokių sub-sąskaitų.', {
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Atgal', callback_data: 'back_finance' }]] }
                });
            }

            let balanceText = '*💳 Sub-sąskaitų Balansai*\n\n';
            balances.forEach(b => {
                balanceText += `*Sub-${b.subId}:* $${b.equity.toFixed(2)} (laisva: $${b.available.toFixed(2)})\n`;
            });

            await ctx.editMessageText(balanceText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔄 Atnaujinti', callback_data: 'finance_balances' }], [{ text: '💸 Pervesti lėšas', callback_data: 'finance_transfer' }], [{ text: '🔙 Atgal', callback_data: 'back_finance' }]] }
            });

        } catch (error) {
            console.error('Klaida finance_balances veiksme:', error);
            await ctx.editMessageText(`🆘 Įvyko klaida: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Atgal', callback_data: 'back_finance' }]] }
            });
        }
    });
    
    bot.action('finance_risk', isAdmin, async (ctx) => {
        await ctx.answerCbQuery('⏳ Tikrinu riziką...');
        await ctx.editMessageText('⏳ Tikrinu laukiančią riziką...');
        let responseText = '*🏦 Laukiančios Rizikos Ataskaita*\n\n';
        let totalPendingRisk = 0;
        let accountsWithRisk = 0;

        try {
            for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
                const key = `sub_account_pending_risk:${i}`;
                const riskStr = await redisClient.get(key);
                const risk = parseFloat(riskStr) || 0;

                if (risk > 0) {
                    accountsWithRisk++;
                    totalPendingRisk += risk;
                    responseText += `*Sub-${i}:* \`$${risk.toFixed(2)}\`\n`;
                }
            }

            if (accountsWithRisk === 0) {
                responseText += '✅ Nėra laukiančios rizikos.';
            } else {
                responseText = `*Iš viso laukia:* \`$${totalPendingRisk.toFixed(2)}\`\n\n` + responseText;
            }
        } catch (error) {
            console.error('Klaida vykdant finance_risk veiksmą:', error);
            responseText = `🆘 Įvyko klaida gaunant duomenis iš Redis: \`${error.message}\``;
        }

        await ctx.editMessageText(responseText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔄 Atnaujinti', callback_data: 'finance_risk' }], [{ text: '🔙 Atgal', callback_data: 'back_finance' }]] }
        });
    });

    // --- PERVEDIMŲ VEIKSMAI ---
    bot.action('finance_transfer', isAdmin, async (ctx) => {
        const balances = await getSubAccountBalances(true);
        const keyboard = balances.map(b => ([{
            text: `Iš Sub-${b.subId} ($${b.equity.toFixed(2)})`,
            callback_data: `transfer_from_${b.subId}`
        }]));
        keyboard.push([{ text: '❌ Atšaukti', callback_data: 'back_finance' }]);
        await ctx.editMessageText('*💸 Pervedimas*\n\nPasirinkite, iš kurios sąskaitos pervesti:', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        ctx.answerCbQuery();
    });

    bot.action(/transfer_from_(\d+)/, isAdmin, async (ctx) => {
        const fromSubId = parseInt(ctx.match[1]);
        const balances = await getSubAccountBalances(true);
        const availableTargets = balances.filter(b => b.subId !== fromSubId);

        if (availableTargets.length === 0) {
            return ctx.answerCbQuery('❌ Nėra kitų sąskaitų, į kurias galima pervesti.', { show_alert: true });
        }

        const keyboard = availableTargets.map(b => ([{
            text: `→ Į Sub-${b.subId} ($${b.equity.toFixed(2)})`,
            callback_data: `transfer_${fromSubId}_to_${b.subId}`
        }]));

        keyboard.push([{ text: '❌ Atšaukti', callback_data: 'back_finance' }]);

        await ctx.editMessageText(
            `*💸 Pervedimas iš Sub-${fromSubId}*\n\nPasirinkite, į kurią sąskaitą pervesti:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
        );
        ctx.answerCbQuery();
    });

    bot.action(/transfer_(\d+)_to_(\d+)/, isAdmin, async (ctx) => {
        const fromSubId = parseInt(ctx.match[1]);
        const toSubId = parseInt(ctx.match[2]);

        const sessionKey = `transfer_session_${ctx.from.id}`;
        await redisClient.set(sessionKey, JSON.stringify({ fromSubId, toSubId }), { EX: 300 });

        await ctx.editMessageText(
            `*💰 Pervedimo nustatymai*\n\n` +
            `*Iš:* Sub-${fromSubId}\n` +
            `*Į:* Sub-${toSubId}\n\n` +
            `*Dabar įveskite norimą pervesti sumą USDT:*`,
            { parse_mode: 'Markdown' }
        );
        ctx.answerCbQuery();
    });

    bot.action(/confirm_transfer_(\d+)_(\d+)_([\d.]+)/, isAdmin, async (ctx) => {
        const fromSubId = parseInt(ctx.match[1]);
        const toSubId = parseInt(ctx.match[2]);
        const amount = parseFloat(ctx.match[3]);

        try {
            await ctx.editMessageText('⏳ Vykdomas pervedimas...');
            const result = await executeInternalTransfer(fromSubId, toSubId, amount);

            if (result.retCode === 0) {
                const sessionKey = `transfer_session_${ctx.from.id}`;
                await redisClient.del(sessionKey);

                await ctx.editMessageText(
                    `✅ *Pervedimas sėkmingas!*\n\n` +
                    `*Suma:* ${amount.toFixed(2)} USDT\n` +
                    `*Iš:* Sub-${fromSubId}\n` +
                    `*Į:* Sub-${toSubId}\n` +
                    `*Pervedimo ID:* \`${result.result.transferId}\``,
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 Grįžti į finansus', callback_data: 'back_finance' }]] } }
                );

                sendTelegramMessage(
                    `💸 *Atliktas vidinis pervedimas*\n\n` +
                    `Sub-${fromSubId} → Sub-${toSubId}\n` +
                    `Suma: *${amount.toFixed(2)} USDT*`
                );

            } else {
                await ctx.editMessageText(
                    `❌ *Pervedimas nepavyko*\n\n` +
                    `*Klaida:* \`${result.retMsg}\``,
                    { reply_markup: { inline_keyboard: [[{ text: '🔙 Grįžti į finansus', callback_data: 'back_finance' }]] } }
                );
            }

        } catch (error) {
            console.error("Klaida vykdant pervedimą:", error);
            await ctx.editMessageText(
                `🆘 *Kritinė pervedimo klaida*\n\n` +
                `*Priežastis:* \`${error.message}\``,
                { reply_markup: { inline_keyboard: [[{ text: '🔙 Grįžti į finansus', callback_data: 'back_finance' }]] } }
            );
        }
        ctx.answerCbQuery();
    });


    // =================================================================
    // === NUSTATYMŲ (SETTINGS) VEIKSMAI ===============================
    // =================================================================
    
    bot.action('settings_risk', isAdmin, async (ctx) => {
        await ctx.answerCbQuery('⚙️ Gaunama konfigūracija...');
        try {
            const currentRisk = await redisClient.get(CONFIG_KEYS.RISK_USD);
            const currentBuffer = await redisClient.get(CONFIG_KEYS.BUFFER_PERCENT);

            let responseText = '*⚙️ Rizikos Konfigūracija*\n\n';
            responseText += `*Fiksuota Rizika (USD):* \`$${currentRisk}\`\n`;
            responseText += `*Saugumo Buferis:* \`${parseFloat(currentBuffer) * 100}%\`\n\n`;
            responseText += 'Pasirinkite parametrą, kurį norite keisti:';

            const keyboard = [
                [{ text: `Keisti Riziką (dabar: $${currentRisk})`, callback_data: `change_config_risk` }],
                [{ text: `Keisti Buferį (dabar: ${parseFloat(currentBuffer) * 100}%)`, callback_data: `change_config_buffer` }],
                [{ text: '🔙 Atgal', callback_data: 'back_settings' }]
            ];

            await ctx.editMessageText(responseText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        } catch (error) {
            console.error('Klaida settings_risk veiksme:', error);
            await ctx.editMessageText(`🆘 Įvyko klaida: ${error.message}`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Atgal', callback_data: 'back_settings' }]] }
            });
        }
    });

    bot.action(/change_config_(.*)/, isAdmin, async (ctx) => {
        const type = ctx.match[1];
        const sessionKey = `config_session_${ctx.from.id}`;
        let promptText = '';

        if (type === 'risk') {
            await redisClient.set(sessionKey, JSON.stringify({ type: CONFIG_KEYS.RISK_USD }), { EX: 300 });
            promptText = 'Įveskite naują fiksuotos rizikos dydį (pvz., `30` arba `25.5`).';
        } else if (type === 'buffer') {
            await redisClient.set(sessionKey, JSON.stringify({ type: CONFIG_KEYS.BUFFER_PERCENT }), { EX: 300 });
            promptText = 'Įveskite naują saugumo buferio procentą (pvz., `25` atitiks 25%). Nenaudokite % ženklo.';
        } else {
            return ctx.answerCbQuery('Nežinomas konfigūracijos tipas.', { show_alert: true });
        }

        await ctx.editMessageText(`*✏️ Parametro Keitimas*\n\n${promptText}`, { parse_mode: 'Markdown' });
        ctx.answerCbQuery();
    });

    // =================================================================
    // === SISTEMOS (SYSTEM) VEIKSMAI ==================================
    // =================================================================
    
    bot.action('system_diagnostics', isAdmin, async (ctx) => {
        await ctx.answerCbQuery('⚙️ Vykdau diagnostiką...');
        await ctx.editMessageText('⚙️ Vykdau techninę diagnostiką... Prašome palaukti.');

        const uptimeMs = new Date() - startTime;
        const uptimeStr = `${Math.floor(uptimeMs / 86400000)}d ${Math.floor((uptimeMs % 86400000) / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`;
        const waitingJobs = await tradingQueue.getWaitingCount();
        const activeJobs = await tradingQueue.getActiveCount();
        const syncReport = await analyzeRedisSync();

        let responseText = '*🛠️ Techninė Diagnostika*\n\n';
        responseText += `*🤖 Boto Būsena*\n`;
        responseText += `• Veikimo laikas: \`${uptimeStr}\`\n`;
        responseText += `• Redis Būsena: \`${redisClient.isReady ? '✅ Prisijungta' : '❌ Atjungta'}\`\n`;
        responseText += `• Signalų Eilė: \`Laukia: ${waitingJobs} | Vykdoma: ${activeJobs}\`\n\n`;
        responseText += `*🔄 Sinchronizacijos Analizė*\n`;
        responseText += `• Valdomi Sandoriai (Redis): \`Iš viso: ${syncReport.totalManagedTrades} | Aktyvūs: ${syncReport.activeManagedTrades} | Laukiantys: ${syncReport.pendingManagedTrades}\`\n`;
        
        const hasIssues = syncReport.unmanagedBybitPositions.length > 0 || syncReport.syncIssues.length > 0 || syncReport.orphanedRedisEntries.length > 0;
        responseText += `\n*📋 Bendras Statusas:*\n`;
        responseText += hasIssues ?
            `\`⚠️ Rasta problemų - peržiūrėkite per "Tik problemos" meniu.\`` :
            `\`✅ Viskas sinchronizuota ir veikia gerai.\``;

        await ctx.editMessageText(responseText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔄 Atnaujinti', callback_data: 'system_diagnostics' }], [{ text: '🔙 Atgal', callback_data: 'back_system' }]] }
        });
    });

    bot.action('system_slots', isAdmin, async (ctx) => {
        await ctx.answerCbQuery('🔍 Tikrinu lizdus...');
        await ctx.editMessageText('🔍 Tikrinu užimtus lizdus Redis duomenų bazėje...');
        let responseText = '*📋 Užimtų Lizdų Ataskaita*\n\n';
        let foundSlots = false;

        try {
            for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
                const key = `sub_account_positions:${i}`;
                const members = await redisClient.sMembers(key);

                if (members.length > 0) {
                    foundSlots = true;
                    responseText += `*Sub-${i}:*\n`;
                    members.forEach(slot => {
                        const [pair, type] = slot.split('_');
                        const side = type === '1' ? 'Long' : 'Short';
                        responseText += `  • \`${pair}\` (${side})\n`;
                    });
                    responseText += '\n';
                }
            }
            if (!foundSlots) responseText += '✅ Visi lizdai laisvi.';
        } catch (error) {
            console.error('Klaida vykdant system_slots veiksmą:', error);
            responseText = `🆘 Įvyko klaida gaunant duomenis iš Redis: \`${error.message}\``;
        }

        await ctx.editMessageText(responseText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔄 Atnaujinti', callback_data: 'system_slots' }], [{ text: '🔙 Atgal', callback_data: 'back_system' }]] }
        });
    });

    bot.action('system_clean', isAdmin, async (ctx) => {
        const confirmationText = `*‼️ DĖMESIO ‼️*\n\nAr tikrai norite ištrinti VISUS boto duomenis iš Redis? Tai apima:\n- Visus aktyvius ir laukiančius sandorius\n- Visus užimtus lizdus\n- Visą "pažadėtą" riziką\n\nŠis veiksmas yra *NEGRĮŽTAMAS*. Prieš tęsdami, įsitikinkite, kad rankiniu būdu atšaukėte visus orderius ir uždarėte pozicijas Bybit!`;
        const keyboard = [
            [{ text: '🔴 TAIP, IŠVALYTI VISKĄ 🔴', callback_data: 'confirm_flush_redis' }],
            [{ text: '✅ Ne, atšaukti', callback_data: 'back_system' }]
        ];
        await ctx.editMessageText(confirmationText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        ctx.answerCbQuery();
    });

    bot.action('confirm_flush_redis', isAdmin, async (ctx) => {
        await ctx.answerCbQuery('⏳ Valoma Redis...');
        try {
            await ctx.editMessageText('⏳ Valoma Redis duomenų bazė...');
            const activeTrades = await redisClient.sMembers('active_trades');
            if (activeTrades.length > 0) {
                const multi = redisClient.multi();
                activeTrades.forEach(trade => multi.del(trade));
                await multi.exec();
            }
            await redisClient.del('active_trades');

            const multiDel = redisClient.multi();
            for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
                multiDel.del(`sub_account_positions:${i}`);
                multiDel.del(`sub_account_pending_risk:${i}`);
            }
            await multiDel.exec();

            await tradingQueue.clean(0, 'completed');
            await tradingQueue.clean(0, 'wait');
            await tradingQueue.clean(0, 'active');
            await tradingQueue.clean(0, 'failed');

            await redisClient.del(CONFIG_KEYS.RISK_USD);
            await redisClient.del(CONFIG_KEYS.BUFFER_PERCENT);
            await initializeConfig();

            await ctx.editMessageText('✅ *Redis duomenų bazė sėkmingai išvalyta!*\n\nBotas paruoštas švariam startui. Konfigūracija atkurta iš numatytųjų reikšmių.', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Grįžti į sistemos meniu', callback_data: 'back_system' }]] }
            });
            sendTelegramMessage('🧹 *Atliktas pilnas Redis duomenų bazės išvalymas.*');
        } catch (error) {
            console.error('Klaida valant Redis DB:', error);
            await ctx.editMessageText(`🆘 *Kritinė klaida valant Redis:*\n\n\`${error.message}\``, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Grįžti į sistemos meniu', callback_data: 'back_system' }]] }
            });
        }
    });
};
