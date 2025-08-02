// failas: telegram_bot/actions.js
// Paskirtis: Perkelti čia visų mygtukų paspaudimų (bot.action(...)) logiką.

import { ADMIN_ID, CONFIG_KEYS, MAX_SUBACCOUNTS_NUM } from '../config.js';
import { redisClient, tradingQueue } from '../services/redis.js';
import { sendTelegramMessage } from '../services/telegram.js';
import { getSubAccountBalances, executeInternalTransfer } from '../utils.js';
// PATAISYMAS: Importuojama iš teisingo failo 'app-setup.js'
import { initializeConfig } from '../app-setup.js';

// Middleware, tikrinantis, ar vartotojas yra administratorius.
const isAdmin = (ctx, next) => {
    if (ctx.from.id === ADMIN_ID) {
        return next();
    }
    // Svarbu: action atveju, atsakome su answerCbQuery, o ne reply.
    return ctx.answerCbQuery('🔒 Ši funkcija prieinama tik administratoriui.', { show_alert: true });
};

export const registerActions = (bot) => {
    // --- PERVEDIMŲ VEIKSMAI ---
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

        keyboard.push([{ text: '❌ Atšaukti', callback_data: 'transfer_cancel' }]);

        try {
            await ctx.editMessageText(
                `*💸 Pervedimas iš Sub-${fromSubId}*\n\nPasirinkite, į kurią sąskaitą pervesti:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                }
            );
        } catch (error) {
            console.error('Edit message error:', error.message);
        }
        ctx.answerCbQuery();
    });

    bot.action(/transfer_(\d+)_to_(\d+)/, isAdmin, async (ctx) => {
        const fromSubId = parseInt(ctx.match[1]);
        const toSubId = parseInt(ctx.match[2]);

        const sessionKey = `transfer_session_${ctx.from.id}`;
        await redisClient.set(sessionKey, JSON.stringify({ fromSubId, toSubId }), { EX: 300 });

        try {
            await ctx.editMessageText(
                `*💰 Pervedimo nustatymai*\n\n` +
                `*Iš:* Sub-${fromSubId}\n` +
                `*Į:* Sub-${toSubId}\n\n` +
                `*Dabar įveskite norimą pervesti sumą USDT:*`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Edit message error:', error.message);
        }
        ctx.answerCbQuery();
    });

    bot.action('transfer_cancel', isAdmin, async (ctx) => {
        try {
            await ctx.editMessageText('❌ Pervedimas atšauktas.');
        } catch (error) {
            console.error('Edit message error:', error.message);
        }
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
                    { parse_mode: 'Markdown' }
                );

                sendTelegramMessage(
                    `💸 *Atliktas vidinis pervedimas*\n\n` +
                    `Sub-${fromSubId} → Sub-${toSubId}\n` +
                    `Suma: *${amount.toFixed(2)} USDT*`
                );

            } else {
                await ctx.editMessageText(
                    `❌ *Pervedimas nepavyko*\n\n` +
                    `*Klaida:* \`${result.retMsg}\``
                );
            }

        } catch (error) {
            console.error("Klaida vykdant pervedimą:", error);
            await ctx.editMessageText(
                `🆘 *Kritinė pervedimo klaida*\n\n` +
                `*Priežastis:* \`${error.message}\``
            );
        }

        ctx.answerCbQuery();
    });

    // --- REDIS VALYMO VEIKSMAI ---
    bot.action('confirm_flush_redis', isAdmin, async (ctx) => {
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

            await ctx.editMessageText('✅ *Redis duomenų bazė sėkmingai išvalyta!*\n\nBotas paruoštas švariam startui. Konfigūracija atkurta iš numatytųjų reikšmių.');
            sendTelegramMessage('🧹 *Atliktas pilnas Redis duomenų bazės išvalymas.*');
        } catch (error) {
            console.error('Klaida valant Redis DB:', error);
            await ctx.editMessageText(`🆘 *Kritinė klaida valant Redis:*\n\n\`${error.message}\``);
        }
        ctx.answerCbQuery();
    });

    bot.action('cancel_flush_redis', isAdmin, async (ctx) => {
        try {
            await ctx.editMessageText('❌ Valymas atšauktas.');
        } catch (error) {
            console.error('Edit message error:', error.message);
        }
        ctx.answerCbQuery();
    });


    // --- KONFIGŪRACIJOS KEITIMO VEIKSMAI ---
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

        try {
            await ctx.editMessageText(`*✏️ Parametro Keitimas*\n\n${promptText}`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Edit message error:', error.message);
        }
        ctx.answerCbQuery();
    });
};
