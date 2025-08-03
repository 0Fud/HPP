// failas: telegram_bot/ux_helpers.js
// Paskirtis: Saugoti visas klases, konstantas ir pagalbines funkcijas,
// susijusias su Telegram boto vartotojo sąsajos (UX) gerinimu.

import { bybitClients } from '../services/bybit.js';
import { getDetailedPositionInfo, getSubAccountBalances } from '../utils.js';

// =================================================================
// === PATOBULINTA TELEGRAM BOTO UX SISTEMA =======================
// =================================================================

// Pagrindinė navigacijos struktūra
export const MAIN_MENU = {
    text: '🎛️ *Bybit Trading Bot v13.0*\n\nPasirinkite veiksmą:',
    keyboard: [
        [{ text: '📊 Apžvalga', callback_data: 'menu_overview' }],
        [{ text: '💰 Finansai', callback_data: 'menu_finance' }, { text: '⚙️ Nustatymai', callback_data: 'menu_settings' }],
        [{ text: '🔧 Sistema', callback_data: 'menu_system' }, { text: '📋 Ataskaitos', callback_data: 'menu_reports' }],
        [{ text: '🆘 Pagalba', callback_data: 'menu_help' }]
    ]
};

// Submeniu struktūros
export const SUBMENUS = {
    overview: {
        text: '📊 *Prekybos Apžvalga*\n\nPasirinkite detalumo lygį:',
        keyboard: [
            [{ text: '📈 Detali apžvalga', callback_data: 'overview_detailed' }],
            [{ text: '🚨 Tik problemos', callback_data: 'overview_issues' }],
            [{ text: '🔙 Atgal', callback_data: 'back_main' }]
        ]
    },
    finance: {
        text: '💰 *Finansų Valdymas*\n\nPasirinkite veiksmą:',
        keyboard: [
            [{ text: '💸 Pervesti lėšas', callback_data: 'finance_transfer' }],
            [{ text: '📊 Balansų apžvalga', callback_data: 'finance_balances' }],
            [{ text: '🛡️ Rizikos būklė', callback_data: 'finance_risk' }],
            [{ text: '🔙 Atgal', callback_data: 'back_main' }]
        ]
    },
    settings: {
        text: '⚙️ *Boto Nustatymai*\n\nKonfigūracijos sritys:',
        keyboard: [
            [{ text: '💵 Rizikos parametrai', callback_data: 'settings_risk' }],
            [{ text: '📱 Pranešimai (netrukus)', callback_data: 'not_implemented' }],
            [{ text: '🔙 Atgal', callback_data: 'back_main' }]
        ]
    },
    system: {
        text: '🔧 *Sistemos Valdymas*\n\nTechninės funkcijos:',
        keyboard: [
            [{ text: '🩺 Diagnostika', callback_data: 'system_diagnostics' }],
            [{ text: '📋 Lizdų būklė', callback_data: 'system_slots' }],
            [{ text: '🗑️ Išvalyti būseną', callback_data: 'system_clean' }],
            [{ text: '🔙 Atgal', callback_data: 'back_main' }]
        ]
    },
    reports: {
        text: '📋 *Ataskaitos ir Analitika*\n\nPasirinkite ataskaitą:',
        keyboard: [
            [{ text: '📊 Dienos santrauka (netrukus)', callback_data: 'not_implemented' }],
            [{ text: '⚠️ Klaidų žurnalas (netrukus)', callback_data: 'not_implemented' }],
            [{ text: '🔙 Atgal', callback_data: 'back_main' }]
        ]
    },
    help: {
        text: '🆘 *Pagalba*\n\nŠiame meniu rasite komandų aprašymus ir kitą naudingą informaciją.\n\n' +
              '*/zurnalas_add* - speciali komanda, skirta rankiniam prekybos įrašų pridėjimui į Redis. Naudoti tik esant būtinybei sinchronizuoti duomenis.\n\n' +
              'Visos kitos funkcijos pasiekiamos per meniu mygtukus.',
        keyboard: [
            [{ text: '🔙 Atgal', callback_data: 'back_main' }]
        ]
    }
};

// =================================================================
// === SESIJŲ VALDYMAS ============================================
// =================================================================

export class SessionManager {
    constructor(redisClient) {
        this.redis = redisClient;
        this.sessionTimeout = 300; // 5 minutės
    }

    async setUserSession(userId, data) {
        const key = `user_session:${userId}`;
        await this.redis.set(key, JSON.stringify(data), { EX: this.sessionTimeout });
    }

    async getUserSession(userId) {
        const key = `user_session:${userId}`;
        const data = await this.redis.get(key);
        return data ? JSON.parse(data) : null;
    }

    async clearUserSession(userId) {
        await this.redis.del(`user_session:${userId}`);
    }

    async updateUserSession(userId, updates) {
        const existing = await this.getUserSession(userId) || {};
        const updated = { ...existing, ...updates };
        await this.setUserSession(userId, updated);
    }
}
