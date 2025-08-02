// failas: utils.js
// Paskirtis: Sudėti visas pagalbines funkcijas.

import { randomUUID } from 'crypto';
import { bybitClients } from './services/bybit.js';
import { redisClient } from './services/redis.js';
import { MAX_SUBACCOUNTS_NUM } from './config.js';

// --- INSTRUMENTO INFORMACIJOS GAVIMAS SU KEŠAVIMU ---
const instrumentInfoCache = new Map();

/**
 * Gauna ir kešuoja informaciją apie prekybos instrumentą (porą).
 * @param {string} symbol - Instrumento simbolis (pvz., 'BTCUSDT').
 * @returns {Promise<object|null>} Objetas su instrumento taisyklėmis arba null, jei įvyko klaida.
 */
export async function getInstrumentInfo(symbol) {
    if (instrumentInfoCache.has(symbol)) return instrumentInfoCache.get(symbol);
    try {
        const mainClient = bybitClients.get(1) || Array.from(bybitClients.values())[0];
        if (!mainClient) throw new Error("Nėra sukonfigūruotų Bybit klientų.");

        const response = await mainClient.getInstrumentsInfo({ category: 'linear', symbol });
        if (response.retCode !== 0 || !response.result.list || response.result.list.length === 0) {
            throw new Error(`Nepavyko gauti ${symbol} informacijos: ${response.retMsg}`);
        }
        const info = response.result.list[0];
        const instrumentData = {
            qtyStep: parseFloat(info.lotSizeFilter.qtyStep),
            minOrderQty: parseFloat(info.lotSizeFilter.minOrderQty),
            tickSize: parseFloat(info.priceFilter.tickSize),
        };
        instrumentInfoCache.set(symbol, instrumentData);
        return instrumentData;
    } catch (error) {
        console.error(`❌ Klaida gaunant ${symbol} informaciją:`, error.message);
        return null;
    }
}

/**
 * Formatuoja skaičių pagal nurodytą žingsnį (apvalina iki reikiamo dešimtainio skaičiaus).
 * @param {number} number - Formatuojamas skaičius.
 * @param {number} step - Žingsnis (pvz., 0.01).
 * @returns {string} Formatuotas skaičius kaip tekstinė eilutė.
 */
export function formatByStep(number, step) {
    const decimals = (step.toString().split('.')[1] || []).length;
    return number.toFixed(decimals);
}

/**
 * Gauna detalią informaciją apie aktyvias pozicijas nurodytoje sub-sąskaitoje.
 * @param {import('bybit-api').RestClientV5} client - Bybit API klientas.
 * @param {number} subAccountId - Sub-sąskaitos ID.
 * @returns {Promise<Array<object>>} Masyvas su detalia pozicijų informacija.
 */
export async function getDetailedPositionInfo(client, subAccountId) {
    try {
        const positionsRes = await client.getPositionInfo({
            category: 'linear',
            settleCoin: 'USDT'
        });

        if (positionsRes.retCode !== 0) {
            throw new Error(`API klaida: ${positionsRes.retMsg}`);
        }

        const activePositions = (positionsRes?.result?.list || []).filter(p => parseFloat(p.size) > 0);
        const detailedPositions = [];

        for (const pos of activePositions) {
            const tradeIds = await redisClient.sMembers('active_trades');
            let managedTradeId = null;
            let isManaged = false;

            for (const tradeId of tradeIds) {
                const tradeData = await redisClient.get(tradeId);
                if (tradeData) {
                    const trade = JSON.parse(tradeData);
                    if (trade.ticker === pos.symbol &&
                        String(trade.subAccountId) === String(subAccountId) &&
                        trade.status === 'ACTIVE') {
                        isManaged = true;
                        managedTradeId = tradeId;
                        break;
                    }
                }
            }

            const hasStopLoss = pos.stopLoss && pos.stopLoss !== "0" && pos.stopLoss !== "";
            const hasTakeProfit = pos.takeProfit && pos.takeProfit !== "0" && pos.takeProfit !== "";

            const unrealisedPnl = parseFloat(pos.unrealisedPnl || 0);
            const entryPrice = parseFloat(pos.avgPrice);
            const positionValue = entryPrice * parseFloat(pos.size);
            const pnlPercent = positionValue > 0 ? (unrealisedPnl / positionValue) * parseFloat(pos.leverage) * 100 : 0;

            detailedPositions.push({
                symbol: pos.symbol, side: pos.side, size: pos.size,
                avgPrice: pos.avgPrice, markPrice: pos.markPrice,
                unrealisedPnl, pnlPercent,
                stopLoss: pos.stopLoss || "0", takeProfit: pos.takeProfit || "0",
                hasStopLoss, hasTakeProfit, isManaged, managedTradeId,
                leverage: pos.leverage
            });
        }
        return detailedPositions;
    } catch (error) {
        console.error(`Klaida gaunant pozicijas Sub-${subAccountId}:`, error.message);
        return [];
    }
}

/**
 * Gauna sąskaitos balansą (UNIFIED).
 * @param {import('bybit-api').RestClientV5} client - Bybit API klientas.
 * @returns {Promise<object|null>} Objetas su balanso informacija arba null.
 */
export async function getAccountBalance(client) {
    try {
        const balanceRes = await client.getWalletBalance({ accountType: 'UNIFIED' });
        if (balanceRes.retCode === 0 && balanceRes.result.list.length > 0) {
            const balance = balanceRes.result.list[0];
            return {
                equity: parseFloat(balance.totalEquity),
                availableBalance: parseFloat(balance.totalAvailableBalance),
                unrealisedPnl: parseFloat(balance.totalUnrealisedPnl),
            };
        }
        return null;
    } catch (error) {
        console.error('Klaida gaunant balansą:', error.message);
        return null;
    }
}

/**
 * Analizuoja Redis ir Bybit duomenų sinchronizaciją, ieško neatitikimų.
 * @returns {Promise<object>} Ataskaitos objektas.
 */
export async function analyzeRedisSync() {
    const syncReport = {
        totalManagedTrades: 0, activeManagedTrades: 0, pendingManagedTrades: 0,
        orphanedRedisEntries: [], unmanagedBybitPositions: [], syncIssues: []
    };

    try {
        const activeTradeIds = await redisClient.sMembers('active_trades');
        syncReport.totalManagedTrades = activeTradeIds.length;
        const redisPositions = new Map();

        for (const tradeId of activeTradeIds) {
            const tradeData = await redisClient.get(tradeId);
            if (tradeData) {
                const trade = JSON.parse(tradeData);
                redisPositions.set(`${trade.ticker}_${trade.subAccountId}`, trade);
                if (trade.status === 'ACTIVE') syncReport.activeManagedTrades++;
                else if (trade.status === 'PENDING') syncReport.pendingManagedTrades++;
            } else {
                syncReport.orphanedRedisEntries.push({ tradeId, issue: 'Nėra duomenų Redis' });
            }
        }

        for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
            const client = bybitClients.get(i);
            if (!client) continue;

            const positions = await getDetailedPositionInfo(client, i);
            for (const pos of positions) {
                const key = `${pos.symbol}_${i}`;
                if (!redisPositions.has(key)) {
                    syncReport.unmanagedBybitPositions.push({ subAccount: i, symbol: pos.symbol, side: pos.side });
                } else {
                    const redisData = redisPositions.get(key);
                    if (redisData.status === 'PENDING') {
                        syncReport.syncIssues.push({
                            type: 'PENDING_BUT_ACTIVE', subAccount: i, symbol: pos.symbol,
                            tradeId: redisData.tradeId, issue: 'Redis rodo PENDING, bet pozicija jau aktyvi Bybit'
                        });
                    }
                    redisPositions.delete(key);
                }
            }
        }

        for (const [, trade] of redisPositions) {
            if (trade.status === 'ACTIVE') {
                syncReport.syncIssues.push({
                    type: 'REDIS_GHOST', subAccount: trade.subAccountId, symbol: trade.ticker,
                    tradeId: trade.tradeId, issue: 'Redis rodo ACTIVE, bet pozicijos nėra Bybit'
                });
            }
        }
    } catch (error) {
        console.error('Klaida analizuojant sinchronizaciją:', error.message);
    }
    return syncReport;
}

/**
 * Gauna visų sub-sąskaitų balansus.
 * @param {boolean} includeZeroBalance - Ar įtraukti sąskaitas su nuliniu balansu.
 * @returns {Promise<Array<object>>} Masyvas su balansų informacija.
 */
export async function getSubAccountBalances(includeZeroBalance = false) {
    const balances = [];
    for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
        const client = bybitClients.get(i);
        if (!client) continue;

        try {
            const balance = await getAccountBalance(client);
            if (balance && (includeZeroBalance || balance.equity > 0)) {
                balances.push({ subId: i, equity: balance.equity, available: balance.availableBalance });
            }
        } catch (e) {
            console.error(`Klaida gaunant Sub-${i} balansą:`, e.message);
        }
    }
    return balances;
}

/**
 * Įvykdo vidinį lėšų pervedimą tarp sub-sąskaitų.
 * @param {number} fromSubId - Iš kurios sąskaitos pervesti.
 * @param {number} toSubId - Į kurią sąskaitą pervesti.
 * @param {number} amount - Suma.
 * @returns {Promise<object>} Bybit API atsakymas.
 */
export async function executeInternalTransfer(fromSubId, toSubId, amount) {
    const mainClient = bybitClients.get(1);
    if (!mainClient) {
        throw new Error('Pagrindinės sąskaitos (Nr. 1) API klientas nerastas.');
    }

    const fromMemberIdStr = (fromSubId === 1)
        ? process.env.BYBIT_MEMBER_ID_MAIN
        : process.env[`BYBIT_MEMBER_ID_${fromSubId}`];

    const toMemberIdStr = (toSubId === 1)
        ? process.env.BYBIT_MEMBER_ID_MAIN
        : process.env[`BYBIT_MEMBER_ID_${toSubId}`];

    if (!fromMemberIdStr) throw new Error(`Trūksta UID įrašo .env faile sąskaitai ${fromSubId}`);
    if (!toMemberIdStr) throw new Error(`Trūksta UID įrašo .env faile sąskaitai ${toSubId}`);

    const transferId = randomUUID();
    const transferParams = {
        transferId, coin: 'USDT', amount: amount.toString(),
        fromMemberId: parseInt(fromMemberIdStr, 10), toMemberId: parseInt(toMemberIdStr, 10),
        fromAccountType: 'UNIFIED', toAccountType: 'UNIFIED'
    };

    return mainClient.createUniversalTransfer(transferParams);
}
