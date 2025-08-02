// failas: app-setup.js
// Paskirtis: Centralizuoti pradinės aplikacijos konfigūracijos logiką.

import { redisClient } from './services/redis.js';
import { CONFIG_KEYS, DEFAULT_FIXED_RISK_USD, DEFAULT_RISK_BUFFER_PERCENTAGE } from './config.js';

/**
 * Inicializuoja pagrindinius konfigūracijos parametrus Redis duomenų bazėje,
 * jei jie dar nebuvo nustatyti. Naudoja numatytąsias reikšmes iš .env failo.
 */
export async function initializeConfig() {
    const risk = await redisClient.get(CONFIG_KEYS.RISK_USD);
    if (risk === null) {
        await redisClient.set(CONFIG_KEYS.RISK_USD, DEFAULT_FIXED_RISK_USD);
        console.log(`[Config] Inicializuota ${CONFIG_KEYS.RISK_USD} su ${DEFAULT_FIXED_RISK_USD}`);
    }

    const buffer = await redisClient.get(CONFIG_KEYS.BUFFER_PERCENT);
    if (buffer === null) {
        await redisClient.set(CONFIG_KEYS.BUFFER_PERCENT, DEFAULT_RISK_BUFFER_PERCENTAGE);
        console.log(`[Config] Inicializuota ${CONFIG_KEYS.BUFFER_PERCENT} su ${DEFAULT_RISK_BUFFER_PERCENTAGE}`);
    }
}
