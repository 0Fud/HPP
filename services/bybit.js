// failas: services/bybit.js
// Paskirtis: Inicializuoja ir eksportuoja bybitClients Map objektą.

import { RestClientV5 } from 'bybit-api';
import { MAX_SUBACCOUNTS_NUM } from '../config.js';

// Sukuriamas Map objektas, kuriame bus saugomi visi Bybit API klientai.
// Raktas bus sub-sąskaitos numeris (pvz., 1), o reikšmė - RestClientV5 instancija.
export const bybitClients = new Map();

/**
 * Inicializuoja Bybit API klientus visoms sub-sąskaitoms,
 * kurioms .env faile yra nurodyti API raktai.
 */
export const initializeBybitClients = () => {
    let initializedClients = 0;
    for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
        const apiKey = process.env[`BYBIT_API_KEY_${i}`];
        const apiSecret = process.env[`BYBIT_API_SECRET_${i}`];

        // Tikrinama, ar abu raktai (API key ir secret) egzistuoja.
        if (apiKey && apiSecret) {
            bybitClients.set(i, new RestClientV5({ key: apiKey, secret: apiSecret, testnet: false }));
            initializedClients++;
        }
    }

    // Patikrinama, ar buvo inicializuotas bent vienas klientas.
    if (initializedClients === 0) {
        const errorMessage = `❌ Kritinė klaida: Nerasta jokių BYBIT_API_KEY_n / BYBIT_API_SECRET_n porų .env faile.`;
        console.error(errorMessage);
        // Jei ne, sustabdomas programos vykdymas.
        throw new Error(errorMessage);
    }

    console.log(`✅ Sėkmingai inicializuota ${initializedClients} iš ${MAX_SUBACCOUNTS_NUM} galimų Bybit klientų.`);
};
