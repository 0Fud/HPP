// failas: telegram_bot/handlers.js
// Paskirtis: Perkelti čia kitus handlerius, pvz., bot.on('text').

import { ADMIN_ID, CONFIG_KEYS } from '../config.js';
import { redisClient } from '../services/redis.js';

// Middleware, tikrinantis, ar vartotojas yra administratorius.
const isAdmin = (ctx, next) => {
    if (ctx.from.id === ADMIN_ID) {
        return next();
    }
    // Paprasto teksto atveju tiesiog ignoruojame, jei siuntėjas ne adminas.
    return;
};

export const registerHandlers = (bot) => {
    bot.on('text', isAdmin, async (ctx) => {
        // Patikriname, ar tai ne komanda, kad išvengtume dvigubo apdorojimo.
        if (ctx.message.text.startsWith('/')) {
            return;
        }

        const configSessionKey = `config_session_${ctx.from.id}`;
        const transferSessionKey = `transfer_session_${ctx.from.id}`;

        const configSessionData = await redisClient.get(configSessionKey);
        const transferSessionData = await redisClient.get(transferSessionKey);

        // --- KONFIGŪRACIJOS KEITIMO SESIJA ---
        if (configSessionData) {
            const { type } = JSON.parse(configSessionData);
            const value = parseFloat(ctx.message.text.replace(',', '.'));

            if (isNaN(value) || value < 0) {
                return ctx.reply('❌ Įvesta netinkama reikšmė. Prašome įvesti teigiamą skaičių.');
            }

            try {
                if (type === CONFIG_KEYS.RISK_USD) {
                    await redisClient.set(type, value);
                    await ctx.replyWithMarkdown(`✅ Rizikos dydis sėkmingai pakeistas į: *${value} USD*`);
                } else if (type === CONFIG_KEYS.BUFFER_PERCENT) {
                    if (value >= 100) {
                        return ctx.reply('❌ Buferis negali būti 100% ar daugiau.');
                    }
                    const bufferValue = value / 100;
                    await redisClient.set(type, bufferValue);
                    await ctx.replyWithMarkdown(`✅ Saugumo buferis sėkmingai pakeistas į: *${value}%*`);
                }
                await redisClient.del(configSessionKey); // Išvalome sesiją
            } catch (error) {
                await ctx.reply(`🆘 Klaida išsaugant nustatymą: ${error.message}`);
            }
        // --- PERVEDIMO SESIJA ---
        } else if (transferSessionData) {
            const { fromSubId, toSubId } = JSON.parse(transferSessionData);
            const amount = parseFloat(ctx.message.text);

            if (isNaN(amount) || amount <= 0) {
                return ctx.reply('❌ Suma turi būti teigiamas skaičius.');
            }

            const keyboard = [
                [{ text: '✅ Taip, patvirtinti', callback_data: `confirm_transfer_${fromSubId}_${toSubId}_${amount}` }],
                [{ text: '❌ Ne, atšaukti', callback_data: 'transfer_cancel' }]
            ];

            await ctx.replyWithMarkdown(
                `*🔔 Pervedimo Patvirtinimas*\n\nAr tikrai norite pervesti *${amount.toFixed(2)} USDT* iš *Sub-${fromSubId}* į *Sub-${toSubId}*?`,
                { reply_markup: { inline_keyboard: keyboard } }
            );
            // Svarbu: neištriname sesijos rakto čia, nes laukiame patvirtinimo mygtuko paspaudimo.
        }
    });
};
