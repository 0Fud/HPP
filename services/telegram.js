// failas: services/telegram.js
// Paskirtis: Inicializuoja Telegraf botą ir valdo pranešimų siuntimą.

import { Telegraf } from 'telegraf';
import axios from 'axios';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID } from '../config.js';

// --- TELEGRAM BOTO INICIALIZAVIMAS ---
// Sukuriama ir eksportuojama Telegraf boto instancija.
export const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// --- PRANEŠIMŲ SIUNTIMO LOGIKA SU EILE ---
// Ši sistema užtikrina, kad pranešimai būtų siunčiami po vieną
// ir būtų laikomasi Telegram API nustatytų apribojimų.
let telegramQueue = [];
let isSendingTelegramMessage = false;

/**
 * Vidinė funkcija, kuri apdoroja pranešimų eilę.
 * Ji ima po vieną pranešimą ir siunčia jį per Telegram API.
 * Turi integruotą klaidų valdymą, ypač "429 Too Many Requests".
 */
const processTelegramQueue = async () => {
    if (telegramQueue.length === 0) {
        isSendingTelegramMessage = false;
        return;
    }
    isSendingTelegramMessage = true;
    const message = telegramQueue.shift();

    try {
        // Naudojamas axios, kad turėti pilną kontrolę virš API užklausų
        // ir išvengti galimų konfliktų su Telegraf vidine logika.
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHANNEL_ID,
            text: message,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
        });
    } catch (error) {
        // Specialus apdorojimas "Too Many Requests" klaidai.
        if (error.response && error.response.status === 429) {
            const retryAfter = error.response.data.parameters.retry_after || 5;
            console.warn(`[Telegram] Pasiektas limitas. Bandoma vėl po ${retryAfter} sek...`);
            // Pranešimas grąžinamas į eilės pradžią, kad būtų išsiųstas vėliau.
            telegramQueue.unshift(message);
            setTimeout(processTelegramQueue, retryAfter * 1000);
            return;
        }
        console.error('Klaida siunčiant pranešimą į Telegram:', error.response?.data || error.message);
    }

    // Pauzė tarp sėkmingų pranešimų, siekiant išvengti API limitų.
    setTimeout(processTelegramQueue, 1500);
};

/**
 * Pagrindinė funkcija, kurią naudos kiti moduliai pranešimams siųsti.
 * Ji saugiai įdeda pranešimą į eilę ir paleidžia apdorojimo procesą, jei jis dar nevyksta.
 * @param {string} message - Pranešimo tekstas (Markdown formatu).
 */
export const sendTelegramMessage = (message) => {
    telegramQueue.push(message);
    if (!isSendingTelegramMessage) {
        processTelegramQueue();
    }
};
