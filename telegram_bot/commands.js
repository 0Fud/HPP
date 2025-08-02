// failas: telegram_bot/commands.js
// Paskirtis: Perkelti čia visų Telegram komandų (bot.command(...)) logiką.

import { ADMIN_ID, MAX_SUBACCOUNTS_NUM, CONFIG_KEYS } from '../config.js';
import { redisClient, tradingQueue } from '../services/redis.js';
import { bybitClients } from '../services/bybit.js';
import { sendTelegramMessage } from '../services/telegram.js';
import {
    getAccountBalance,
    getDetailedPositionInfo,
    analyzeRedisSync,
    getSubAccountBalances,
} from '../utils.js';
import { initializeConfig } from '../server.js'; // Importuojama iš pagrindinio failo

// Middleware, tikrinantis, ar vartotojas yra administratorius.
const isAdmin = (ctx, next) => {
    if (ctx.from.id === ADMIN_ID) {
        return next();
    }
    return ctx.reply('🔒 Ši funkcija prieinama tik administratoriui.');
};

// Laikinas kintamasis, kol neturime geresnio sprendimo startavimo laikui
// TODO: Pergalvoti, kaip elegantiškiau perduoti startavimo laiką
const startTime = new Date();

export const registerCommands = (bot) => {
    // =================================================================
    // === LAIKINAS TAISYMO ĮRANKIS =====================================
    // =================================================================
    bot.command('zurnalas_add', isAdmin, async (ctx) => {
        try {
            // Ši regex taisyklė teisingai apdoroja argumentus, įskaitant tuos, kurie yra kabutėse
            const args = ctx.message.text.match(/(?:[^\s"]+|"[^"]*")+/g).slice(1);

            if (args.length < 6) {
                return ctx.replyWithMarkdown('Naudojimas:\n`/zurnalas_add "<tradeId>" <tipas> <ticker> <subId> <kryptis> ...`\nTipai: `active`, `pending`');
            }

            const tradeIdWithQuotes = args[0];
            const type = args[1];
            const ticker = args[2];
            const subAccountIdStr = args[3];
            const direction = args[4];

            const tradeId = tradeIdWithQuotes.replace(/"/g, ''); // Pašalinamos kabutės

            const subAccountId = parseInt(subAccountIdStr);
            if (isNaN(subAccountId)) {
                return ctx.reply(`❌ Netinkamas Sub-sąskaitos ID. Gauta reikšmė: \`${subAccountIdStr}\`. Patikrinkite komandos struktūrą.`);
            }

            const positionIdx = direction === 'long' ? 1 : 2;
            const positionKey = `${ticker}_${positionIdx}`;
            const activePositionsSetKey = `sub_account_positions:${subAccountId}`;
            const fixedRisk = parseFloat(await redisClient.get(CONFIG_KEYS.RISK_USD) || '30');

            if (type === 'active') {
                if (args.length < 9) {
                    return ctx.reply('Trūksta argumentų `active` tipui. Reikia: "<tradeId>" active <ticker> <subId> <kryptis> <kiekis> <įėjimas> <sl> <tp>');
                }
                const [qty, entryPrice, stopLoss, takeProfit] = args.slice(5);

                const tradeContext = {
                    tradeId, orderId: `manual-${tradeId}`, ticker, direction,
                    entryPrice, stopLoss, takeProfit, patternName: 'Manual Sync',
                    qty, subAccountId, status: 'ACTIVE', riskUsd: fixedRisk
                };

                await redisClient.set(tradeId, JSON.stringify(tradeContext));
                await redisClient.sAdd('active_trades', tradeId);
                await redisClient.sAdd(activePositionsSetKey, positionKey);

                await ctx.replyWithMarkdown(`✅ *Aktyvus sandoris pridėtas:*\nTicker: \`${ticker}\` | ID: \`${tradeId}\` | Statusas: \`ACTIVE\``);

            } else if (type === 'pending') {
                if (args.length < 6) {
                    return ctx.reply('Trūksta argumentų `pending` tipui. Reikia: "<tradeId>" pending <ticker> <subId> <kryptis> <įėjimo_kaina>');
                }
                const [entryPrice] = args.slice(5);

                const tradeContext = {
                    tradeId, orderId: `manual-pending-${tradeId}`, ticker, direction,
                    entryPrice, stopLoss: '0', takeProfit: '0', patternName: 'Manual Sync (Pending)',
                    qty: '0', subAccountId, status: 'PENDING', riskUsd: fixedRisk
                };

                await redisClient.set(tradeId, JSON.stringify(tradeContext));
                await redisClient.sAdd('active_trades', tradeId);
                await redisClient.sAdd(activePositionsSetKey, positionKey);

                const pendingRiskKey = `sub_account_pending_risk:${subAccountId}`;
                await redisClient.incrByFloat(pendingRiskKey, fixedRisk);

                await ctx.replyWithMarkdown(`✅ *Laukiantis sandoris pridėtas:*\nTicker: \`${ticker}\` | ID: \`${tradeId}\` | Statusas: \`PENDING\`\nPridėta rizika: \`$${fixedRisk}\``);

            } else {
                return ctx.reply('❌ Nežinomas tipas. Naudokite `active` arba `pending`.');
            }
        } catch (error) {
            console.error('Klaida /zurnalas_add komandoje:', error);
            await ctx.reply(`🆘 Įvyko klaida: ${error.message}`);
        }
    });

    bot.start(isAdmin, (ctx) => {
        ctx.replyWithMarkdown(
            'Sveiki! Aš esu jūsų Bybit prekybos asistentas (v16.2 - Taisymo Režimas).\n\n' +
            '*Pagrindinės komandos:*\n' +
            '/apzvalga, /sistema, /transfer, /lizdai, /rizika, /config, /isvalyti\n\n' +
            '*Taisymo komanda:*\n' +
            '`/zurnalas_add` - Rankinis įrašų pridėjimas. Naudoti atsargiai!'
        );
    });

    bot.command('apzvalga', isAdmin, async (ctx) => {
        await ctx.reply('🔍 Analizuoju prekybos būklę... Prašome palaukti.');

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
                        const managedIcon = pos.isManaged ? '✅' : '�';
                        const protectionIcon = pos.hasStopLoss && pos.hasTakeProfit ? '🛡️' : '⚠️';
                        const sideIcon = pos.side === 'Buy' ? '📈' : '📉';

                        const pnlSignPos = pos.unrealisedPnl >= 0 ? '+' : '';
                        const pnlText = `${pnlSignPos}${pos.unrealisedPnl.toFixed(2)} (${pnlSignPos}${pos.pnlPercent.toFixed(1)}%)`;

                        responseText += `  ${managedIcon}${protectionIcon} ${sideIcon} *${pos.symbol}* | P/L: \`${pnlText}\`\n`;
                        responseText += `    Entry: \`${pos.avgPrice}\` | Current: \`${pos.markPrice}\`\n`;
                        responseText += `    SL: \`${pos.stopLoss === '0' ? 'Nėra' : pos.stopLoss}\` | TP: \`${pos.takeProfit === '0' ? 'Nėra' : pos.takeProfit}\`\n`;

                        if (!pos.isManaged) {
                            unmanagedPositions.push(`Sub-${i}: ${pos.symbol} (${pos.side})`);
                        }
                        if (!pos.hasStopLoss || !pos.hasTakeProfit) {
                            let reason = [];
                            if (!pos.hasStopLoss) reason.push("SL");
                            if (!pos.hasTakeProfit) reason.push("TP");
                            unprotectedPositions.push(`Sub-${i}: ${pos.symbol} (trūksta ${reason.join(' ir ')})`);
                        }
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
        header += `*Aktyvios Pozicijos:* \`${totalActivePositions}\`\n`;

        const criticalIssuesCount = unmanagedPositions.length;
        header += `*🚨 Kritinės Problemos:* \`${criticalIssuesCount}\` ${criticalIssuesCount > 0 ? '⚠️' : '✅'}\n\n`;

        responseText = header + responseText;

        if (unmanagedPositions.length > 0 || unprotectedPositions.length > 0) {
            responseText += `*📋 Problemų Santrauka*\n`;
            if (unmanagedPositions.length > 0) {
                responseText += `*🚨 Nevaldomos Pozicijos (${unmanagedPositions.length}):*\n`;
                unmanagedPositions.forEach(p => responseText += `  • \`${p}\`\n`);
            }
            if (unprotectedPositions.length > 0) {
                responseText += `*⚠️ Neapsaugotos Pozicijos (${unprotectedPositions.length}):*\n`;
                unprotectedPositions.forEach(p => responseText += `  • \`${p}\`\n`);
            }
        }

        if (responseText.length > 4096) {
            const parts = responseText.match(/[\s\S]{1,4096}/g) || [];
            for (const part of parts) {
                await ctx.replyWithMarkdown(part);
            }
        } else {
            await ctx.replyWithMarkdown(responseText);
        }
    });

    bot.command('sistema', isAdmin, async (ctx) => {
        await ctx.reply('⚙️ Vykdau techninę diagnostiką... Prašome palaukti.');

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

        if (syncReport.unmanagedBybitPositions.length > 0) {
            responseText += `*🚨 Nevaldomos Bybit Pozicijos (${syncReport.unmanagedBybitPositions.length}):*\n`;
            syncReport.unmanagedBybitPositions.slice(0, 5).forEach(p => {
                responseText += `  • \`Sub-${p.subAccount}: ${p.symbol} (${p.side})\`\n`;
            });
            if (syncReport.unmanagedBybitPositions.length > 5) responseText += `  ... ir dar ${syncReport.unmanagedBybitPositions.length - 5}\n`;
        }

        if (syncReport.syncIssues.length > 0) {
            responseText += `*👻 Redis "Vaiduokliai" / Neatitikimai (${syncReport.syncIssues.length}):*\n`;
            syncReport.syncIssues.slice(0, 5).forEach(issue => {
                responseText += `  • \`Sub-${issue.subAccount}: ${issue.symbol}\` (${issue.type})\n`;
            });
            if (syncReport.syncIssues.length > 5) responseText += `  ... ir dar ${syncReport.syncIssues.length - 5}\n`;
        }

        if (syncReport.orphanedRedisEntries.length > 0) {
            responseText += `*🗑️ Pažeisti Redis Įrašai (${syncReport.orphanedRedisEntries.length}):*\n`;
            syncReport.orphanedRedisEntries.slice(0, 5).forEach(entry => {
                responseText += `  • \`TradeID: ${entry.tradeId}\`\n`;
            });
        }

        const hasIssues = syncReport.unmanagedBybitPositions.length > 0 || syncReport.syncIssues.length > 0 || syncReport.orphanedRedisEntries.length > 0;
        responseText += `\n*📋 Bendras Statusas:*\n`;
        responseText += hasIssues ?
            `\`⚠️ Rasta problemų - reikia peržiūros.\`` :
            `\`✅ Viskas sinchronizuota ir veikia gerai.\``;

        await ctx.replyWithMarkdown(responseText);
    });

    bot.command('lizdai', isAdmin, async (ctx) => {
        await ctx.reply('🔍 Tikrinu užimtus lizdus Redis duomenų bazėje...');
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

            if (!foundSlots) {
                responseText += '✅ Visi lizdai laisvi.';
            }
        } catch (error) {
            console.error('Klaida vykdant /lizdai komandą:', error);
            responseText = `🆘 Įvyko klaida gaunant duomenis iš Redis: \`${error.message}\``;
        }

        await ctx.replyWithMarkdown(responseText);
    });

    bot.command('transfer', isAdmin, async (ctx) => {
        await ctx.reply('💰 Gaunami sub-sąskaitų balansai...');

        try {
            const balances = await getSubAccountBalances(true);
            if (balances.length < 1) {
                return ctx.reply('❌ Nerasta jokių sub-sąskaitų.');
            }

            let balanceText = '*💳 Sub-sąskaitų Balansai*\n\n';
            balances.forEach(b => {
                balanceText += `*Sub-${b.subId}:* $${b.equity.toFixed(2)} (laisva: $${b.available.toFixed(2)})\n`;
            });

            const keyboard = balances.map(b => ([{
                text: `Pervesti iš Sub-${b.subId}`,
                callback_data: `transfer_from_${b.subId}`
            }]));

            await ctx.replyWithMarkdown(balanceText, {
                reply_markup: { inline_keyboard: keyboard }
            });

        } catch (error) {
            console.error('Klaida /transfer komandoje:', error);
            await ctx.reply(`🆘 Įvyko klaida: ${error.message}`);
        }
    });

    bot.command('rizika', isAdmin, async (ctx) => {
        await ctx.reply('⏳ Tikrinu laukiančią riziką...');
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
            console.error('Klaida vykdant /rizika komandą:', error);
            responseText = `🆘 Įvyko klaida gaunant duomenis iš Redis: \`${error.message}\``;
        }

        await ctx.replyWithMarkdown(responseText);
    });

    bot.command('isvalyti', isAdmin, async (ctx) => {
        const confirmationText = `*‼️ DĖMESIO ‼️*\n\nAr tikrai norite ištrinti VISUS boto duomenis iš Redis? Tai apima:\n- Visus aktyvius ir laukiančius sandorius\n- Visus užimtus lizdus\n- Visą "pažadėtą" riziką\n\nŠis veiksmas yra *NEGRĮŽTAMAS*. Prieš tęsdami, įsitikinkite, kad rankiniu būdu atšaukėte visus orderius ir uždarėte pozicijas Bybit!`;

        const keyboard = [
            [{ text: '🔴 TAIP, IŠVALYTI VISKĄ 🔴', callback_data: 'confirm_flush_redis' }],
            [{ text: '✅ Ne, atšaukti', callback_data: 'cancel_flush_redis' }]
        ];

        await ctx.replyWithMarkdown(confirmationText, {
            reply_markup: { inline_keyboard: keyboard }
        });
    });

    bot.command('config', isAdmin, async (ctx) => {
        await ctx.reply('⚙️ Gaunama dabartinė konfigūracija...');
        try {
            const currentRisk = await redisClient.get(CONFIG_KEYS.RISK_USD);
            const currentBuffer = await redisClient.get(CONFIG_KEYS.BUFFER_PERCENT);

            let responseText = '*⚙️ Boto Konfigūracija*\n\n';
            responseText += `*Fiksuota Rizika (USD):* \`$${currentRisk}\`\n`;
            responseText += `*Saugumo Buferis:* \`${parseFloat(currentBuffer) * 100}%\`\n\n`;
            responseText += 'Pasirinkite parametrą, kurį norite keisti:';

            const keyboard = [
                [{ text: `Keisti Riziką (dabar: $${currentRisk})`, callback_data: `change_config_risk` }],
                [{ text: `Keisti Buferį (dabar: ${parseFloat(currentBuffer) * 100}%)`, callback_data: `change_config_buffer` }]
            ];

            await ctx.replyWithMarkdown(responseText, {
                reply_markup: { inline_keyboard: keyboard }
            });
        } catch (error) {
            console.error('Klaida /config komandoje:', error);
            await ctx.reply(`🆘 Įvyko klaida: ${error.message}`);
        }
    });
};