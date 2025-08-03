// failas: telegram_bot/commands.js
// Paskirtis: Perkelti čia visų Telegram komandų (bot.command(...)) logiką.

import { ADMIN_ID, CONFIG_KEYS } from '../config.js';
import { redisClient } from '../services/redis.js';
import { MAIN_MENU, SessionManager } from './ux_helpers.js';

// Middleware, tikrinantis, ar vartotojas yra administratorius.
const isAdmin = (ctx, next) => {
    if (ctx.from.id === ADMIN_ID) {
        return next();
    }
    return ctx.reply('🔒 Ši funkcija prieinama tik administratoriui.');
};

export const registerCommands = (bot) => {
    // =================================================================
    // === PAGRINDINĖS KOMANDOS ========================================
    // =================================================================

    // Patobulinta /start komanda su welcome flow
    bot.start(isAdmin, async (ctx) => {
        const welcomeText = `🎉 *Sveiki atvykę į Bybit Trading Bot v13.0!*\n\n` +
            `Jūsų galimybės:\n` +
            `✅ Realaus laiko prekybos stebėjimas\n` +
            `✅ Automatinis rizikos valdymas\n` +
            `✅ Multi-sąskaitų koordinavimas\n` +
            `✅ Detalios ataskaitos ir analitika\n` +
            `✅ Lanksčios konfigūracijos\n\n` +
            `*🚀 Pradėkime!*`;

        // Išvalome senus pranešimus, jei įmanoma
        try {
            await ctx.deleteMessage();
        } catch (error) {
            // Ignoruojame klaidą, jei pranešimo ištrinti nepavyksta (pvz., per senas)
        }

        await ctx.replyWithMarkdown(welcomeText, {
            reply_markup: { inline_keyboard: MAIN_MENU.keyboard }
        });

        // Inicializuoti user session
        const sessionManager = new SessionManager(redisClient);
        await sessionManager.setUserSession(ctx.from.id, {
            startTime: new Date(),
            lastActivity: new Date(),
            menuPath: ['main']
        });
    });


    // =================================================================
    // === RANKINIO TAISYMO ĮRANKIS ====================================
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
};
