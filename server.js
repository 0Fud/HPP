// failas: server.js
// Paskirtis: Aplikacijos paleidimo taškas.

import express from 'express';
import { port, MAX_SUBACCOUNTS_NUM } from './config.js';
import { redisClient, tradingQueue } from './services/redis.js';
import { bybitClients, initializeBybitClients } from './services/bybit.js';
import { bot, sendTelegramMessage } from './services/telegram.js';
import { initializeConfig } from './app-setup.js';
import { registerCommands } from './telegram_bot/commands.js';
import { registerActions } from './telegram_bot/actions.js';
import { registerHandlers } from './telegram_bot/handlers.js';

// --- EXPRESS SERVERIO INICIALIZAVIMAS ---
const app = express();
app.use(express.json());

// --- WEBHOOK ENDPOINT ---
app.post('/webhook', async (req, res) => {
    console.log('\n--- Gaunamas signalas, dedamas į eilę ---');
    const data = req.body;

    if (!data.tradeId) {
        return res.status(400).json({ status: 'error', message: 'Trūksta privalomo `tradeId` lauko.' });
    }
    console.log('Gauti duomenys:', data);

    if (!data.action || !data.ticker) {
        return res.status(400).json({ status: 'error', message: 'Trūksta veiksmo (action) arba poros (ticker).' });
    }

    try {
        await tradingQueue.add('signal', data);
        res.status(202).json({ status: 'accepted', message: 'Signalas priimtas ir įdėtas į eilę apdorojimui.' });
    } catch (error) {
        console.error('❌ KLAIDA DEDANT Į EILĘ:', error.message);
        sendTelegramMessage(`🆘 *Boto Vidinė Klaida*\n\n*Problema:* Nepavyko pridėti signalo į eilę.\n*Priežastis:* \`${error.message}\``);
        res.status(500).json({ status: 'error', error: 'Failed to queue signal.' });
    }
});


// --- SERVERIO PALEIDIMO FUNKCIJA ---
const startServer = async () => {
    try {
        // 1. Inicializuojami Bybit API klientai
        initializeBybitClients();

        // 2. Prisijungiama prie Redis
        await redisClient.connect();
        console.log("✅ Sėkmingai prisijungta prie Redis.");

        // 3. Inicializuojama pradinė konfigūracija Redis'e
        await initializeConfig();

        // 4. Registruojami visi Telegram boto valdikliai
        registerCommands(bot);
        registerActions(bot);
        registerHandlers(bot);

        // 5. Paleidžiamas Express serveris
        app.listen(port, '0.0.0.0', () => {
            const msg = `🚀 Bybit botas (v13.0 - Naujas UX) paleistas ant porto ${port}\n` +
                `- Aktyvuota ${bybitClients.size} iš ${MAX_SUBACCOUNTS_NUM} sub-sąskaitų.\n` +
                `- Eilės sistema veikia.\n` +
                `- Telegram botas klauso komandų.`;
            console.log(msg);
            sendTelegramMessage(msg);
        });

        // 6. Paleidžiamas Telegram botas
        bot.launch();
        console.log("✅ Telegram botas paleistas naudojant Long Polling.");

        // Saugus programos išjungimas
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));

    } catch (err) {
        console.error("❌ Kritinė klaida paleidžiant serverį:", err);
        process.exit(1);
    }
};

// --- APLIKACIJOS PALEIDIMAS ---
startServer();
