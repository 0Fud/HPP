// failas: config.js
// Paskirtis: Centralizuoti visą konfigūraciją.

import 'dotenv/config';

// --- APLIKACIJOS KONFIGŪRACIJA ---
export const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHANNEL_ID,
    TELEGRAM_ADMIN_ID,
    DEFAULT_FIXED_RISK_USD = '30',
    DEFAULT_RISK_BUFFER_PERCENTAGE = '0.25',
    GOOGLE_SHEET_ID,
    GOOGLE_CREDENTIALS_PATH,
    REDIS_URL,
    MAX_SUBACCOUNTS = '20',
    PORT = '3000'
} = process.env;

// --- KRITINIŲ KINTAMŲJŲ PATIKRINIMAS ---
const requiredEnvVars = [
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID', 'TELEGRAM_ADMIN_ID',
    'GOOGLE_SHEET_ID', 'GOOGLE_CREDENTIALS_PATH', 'REDIS_URL'
];

for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
        const errorMessage = `❌ Trūksta būtino .env kintamojo: ${varName}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
    }
}

// --- GLOBALios KONSTANTOS ---
export const MAX_SUBACCOUNTS_NUM = parseInt(MAX_SUBACCOUNTS, 10);
export const ADMIN_ID = parseInt(TELEGRAM_ADMIN_ID, 10);
export const port = PORT;

// --- KONFIGŪRACIJOS RAKTŲ PAVADINIMAI ---
export const CONFIG_KEYS = {
    RISK_USD: 'config:fixed_risk_usd',
    BUFFER_PERCENT: 'config:risk_buffer_percentage'
};
