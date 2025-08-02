// failas: worker.js
// Paskirtis: Apdoroti užduotis iš BullMQ eilės.

import { CONFIG_KEYS, MAX_SUBACCOUNTS_NUM } from './config.js';
import { redisClient } from './services/redis.js';
import { bybitClients } from './services/bybit.js';
import { sendTelegramMessage } from './services/telegram.js';
import { appendToSheet } from './services/google.js';
import { getInstrumentInfo, formatByStep, getAccountBalance } from './utils.js';

/**
 * Pagrindinė funkcija, apdorojanti užduotis iš BullMQ eilės.
 * @param {import('bullmq').Job} job - Užduoties objektas iš eilės.
 */
export async function handleJob(job) {
    const data = job.data;
    const { action, tradeId } = data;
    const ticker = data.ticker.replace('.P', '');
    console.log(`\n--- Pradedama vykdyti užduotis ${job.id} | Trade ID: ${tradeId} ---`);

    try {
        const riskUsdStr = await redisClient.get(CONFIG_KEYS.RISK_USD);
        const bufferPercentStr = await redisClient.get(CONFIG_KEYS.BUFFER_PERCENT);

        const fixedRisk = parseFloat(riskUsdStr);
        const riskBuffer = parseFloat(bufferPercentStr);

        if (action === 'NEW_PATTERN') {
            const existingTrade = await redisClient.get(tradeId);
            if (existingTrade) {
                console.warn(`[${tradeId}] Šis sandoris jau yra apdorojamas. Ignoruojama.`);
                return;
            }

            const instrument = await getInstrumentInfo(ticker);
            if (!instrument) throw new Error(`Kritinė klaida: nepavyko gauti ${ticker} prekybos taisyklių.`);

            let tradePlaced = false;

            for (let i = 1; i <= MAX_SUBACCOUNTS_NUM; i++) {
                const subAccountId = i;
                const bybitClient = bybitClients.get(subAccountId);
                if (!bybitClient) continue;

                const positionKey = `${ticker}_${data.positionIdx}`;
                const activePositionsSetKey = `sub_account_positions:${subAccountId}`;
                const isPositionActiveInRedis = await redisClient.sIsMember(activePositionsSetKey, positionKey);

                if (isPositionActiveInRedis) {
                    console.log(`[Sub-${subAccountId}] Lizdas ${positionKey} užimtas Redis. Ieškoma toliau.`);
                    continue;
                }

                try {
                    const balance = await getAccountBalance(bybitClient);
                    if (!balance || balance.equity < fixedRisk) {
                        continue;
                    }

                    const pendingRiskKey = `sub_account_pending_risk:${subAccountId}`;
                    const pendingRiskStr = await redisClient.get(pendingRiskKey);
                    const pendingRisk = parseFloat(pendingRiskStr) || 0;

                    const maxAllowedTotalRisk = balance.equity * (1 - riskBuffer);

                    if ((pendingRisk + fixedRisk) <= maxAllowedTotalRisk) {
                        console.log(`[Sub-${subAccountId}] Rizikos patikrinimas sėkmingas. Bendra rizika ($${(pendingRisk + fixedRisk).toFixed(2)}) neviršija leistinos ($${maxAllowedTotalRisk.toFixed(2)}).`);

                        const positionInfo = await bybitClient.getPositionInfo({ category: 'linear', symbol: ticker });
                        if (positionInfo.retCode !== 0 || !positionInfo.result.list) {
                            console.log(`[Sub-${subAccountId}] Klaida gaunant pozicijos info iš Bybit: ${positionInfo.retMsg}. Tęsiama su kita sąskaita.`);
                            continue;
                        }
                        const positionData = positionInfo.result.list.find(p => p.symbol === ticker && p.positionIdx === data.positionIdx);
                        if (!positionData || !positionData.leverage) {
                            console.log(`[Sub-${subAccountId}] Gautuose duomenyse nerasta ${ticker} (positionIdx: ${data.positionIdx}) sverto informacijos. Tęsiama su kita sąskaita.`);
                            continue;
                        }
                        const leverage = parseFloat(positionData.leverage);

                        const entryPrice = parseFloat(data.entryPrice);
                        const takeProfit = parseFloat(data.takeProfit);
                        const profitDistance = Math.abs(takeProfit - entryPrice);
                        const riskDistance = profitDistance / 2;
                        const stopLoss = data.direction === 'long' ? entryPrice - riskDistance : entryPrice + riskDistance;
                        const sl_percent = Math.abs(entryPrice - stopLoss) / entryPrice;

                        if (sl_percent === 0) throw new Error('Stop Loss negali būti lygus įėjimo kainai.');

                        const position_size_raw = fixedRisk / (entryPrice * sl_percent);
                        const qty = formatByStep(position_size_raw, instrument.qtyStep);

                        if (parseFloat(qty) < instrument.minOrderQty) {
                            const errorMsg = `Apskaičiuotas kiekis (${qty}) yra mažesnis už minimalų leidžiamą (${instrument.minOrderQty}). Sandoris atmetamas.`;
                            sendTelegramMessage(`⚠️ *ATMestas Sandoris* [${ticker}]\n\n*Priežastis:* ${errorMsg}\n*Trade ID:* \`${tradeId}\``);
                            tradePlaced = true;
                            break;
                        }

                        const order = {
                            category: 'linear', symbol: ticker, side: data.direction === 'long' ? 'Buy' : 'Sell',
                            orderType: 'Market', qty: String(qty), triggerPrice: formatByStep(entryPrice, instrument.tickSize),
                            triggerDirection: data.direction === 'long' ? 1 : 2, positionIdx: data.positionIdx,
                        };

                        const orderResponse = await bybitClient.submitOrder(order);

                        if (orderResponse.retCode === 0) {
                            const orderId = orderResponse.result.orderId;
                            const tradeContext = {
                                tradeId, orderId, ticker, direction: data.direction,
                                entryPrice: order.triggerPrice, stopLoss: formatByStep(stopLoss, instrument.tickSize),
                                takeProfit: formatByStep(takeProfit, instrument.tickSize),
                                patternName: data.patternName || 'Nenurodyta', qty: qty, subAccountId,
                                status: 'PENDING', riskUsd: fixedRisk
                            };

                            await redisClient.set(tradeId, JSON.stringify(tradeContext));
                            await redisClient.sAdd('active_trades', tradeId);
                            await redisClient.sAdd(activePositionsSetKey, positionKey);
                            await redisClient.incrByFloat(pendingRiskKey, fixedRisk);

                            const positionValueUSD = parseFloat(qty) * entryPrice;
                            const successMessage = `[Sub-${subAccountId}] ✅ *Pateiktas Sąlyginis Orderis*\n\n` +
                                `*Pora:* \`${ticker}\`\n*Kryptis:* ${data.direction.toUpperCase()}\n` +
                                `*Rizika:* \`${fixedRisk.toFixed(2)} USD\`\n\n` +
                                `*Įėjimas:* \`${tradeContext.entryPrice}\`\n*Stop Loss:* \`${tradeContext.stopLoss}\`\n*Take Profit:* \`${tradeContext.takeProfit}\`\n\n` +
                                `*Dydis:* \`${qty} ${ticker.replace('USDT', '')}\` (~${positionValueUSD.toFixed(2)} USD)\n*Svertas:* \`${leverage}x\`\n*Trade ID:* \`${tradeId}\``;
                            sendTelegramMessage(successMessage);
                            tradePlaced = true;
                            break;
                        } else {
                            sendTelegramMessage(`[Sub-${subAccountId}] ❌ *Orderis ATMestas*\n\n*Pora:* \`${ticker}\`\n*Bybit Klaida (${orderResponse.retCode}):*\n\`${orderResponse.retMsg}\`\n*Trade ID:* \`${tradeId}\``);
                        }
                    } else {
                        console.log(`[Sub-${subAccountId}] Nepakanka lėšų arba viršytas rizikos buferis. Laukia: $${pendingRisk.toFixed(2)}, Reikalinga: $${fixedRisk.toFixed(2)}, Maks. leistina: $${maxAllowedTotalRisk.toFixed(2)}. Ieškoma toliau.`);
                    }
                } catch (error) {
                    console.error(`[Sub-${subAccountId}] Kritinė klaida TRY bloke:`, error.message, error.stack);
                }
            }

            if (!tradePlaced) {
                sendTelegramMessage(`⚠️ *Visos Sąskaitos Užimtos arba Nepakanka Lėšų*\n\n*Pora:* \`${ticker}\`\nNebuvo rastos tinkamos sub-sąskaitos naujam sandoriui.\n*Trade ID:* \`${tradeId}\``);
            }
        } else {
            const tradeContextJSON = await redisClient.get(tradeId);
            if (!tradeContextJSON) {
                console.warn(`[${tradeId}] Gautas signalas veiksmui "${action}", bet nerasta aktyvaus sandorio su šiuo ID.`);
                return;
            }

            const tradeContext = JSON.parse(tradeContextJSON);
            const bybitClient = bybitClients.get(tradeContext.subAccountId);
            if (!bybitClient) throw new Error(`Nerastas Bybit klientas sub-sąskaitai ${tradeContext.subAccountId}`);

            const riskToRelease = tradeContext.riskUsd || fixedRisk;
            const pendingRiskKey = `sub_account_pending_risk:${tradeContext.subAccountId}`;
            const positionKey = `${tradeContext.ticker}_${tradeContext.direction === 'long' ? 1 : 2}`;
            const activePositionsSetKey = `sub_account_positions:${tradeContext.subAccountId}`;

            switch (action) {
                case 'INVALIDATE_PATTERN': {
                    const cancelResponse = await bybitClient.cancelOrder({ category: 'linear', symbol: tradeContext.ticker, orderId: tradeContext.orderId });
                    if (cancelResponse.retCode === 0 || cancelResponse.retMsg.toLowerCase().includes('order not exists or too late to cancel')) {
                        if (tradeContext.status === 'PENDING') {
                            await redisClient.incrByFloat(pendingRiskKey, -riskToRelease);
                        }
                        await redisClient.del(tradeId);
                        await redisClient.sRem('active_trades', tradeId);
                        await redisClient.sRem(activePositionsSetKey, positionKey);
                        sendTelegramMessage(`[Sub-${tradeContext.subAccountId}] 🗑️ *Sąlyginis Orderis Atšauktas*\n\n*Pora:* \`${tradeContext.ticker}\`\n*Trade ID:* \`${tradeId}\``);
                    } else {
                        sendTelegramMessage(`[Sub-${tradeContext.subAccountId}] ⚠️ *Klaida Atšaukiant Orderį*\n\n*Pora:* \`${tradeContext.ticker}\`\n*Bybit Atsakymas:* \`${cancelResponse.retMsg}\`\n*Trade ID:* \`${tradeId}\``);
                    }
                    break;
                }
                case 'ENTERED_POSITION': {
                    const setStopResponse = await bybitClient.setTradingStop({
                        category: 'linear',
                        symbol: tradeContext.ticker,
                        positionIdx: tradeContext.direction === 'long' ? 1 : 2,
                        stopLoss: String(data.stopLoss),
                        takeProfit: String(data.takeProfit)
                    });

                    if (setStopResponse.retCode === 0) {
                        if (tradeContext.status === 'PENDING') {
                            await redisClient.incrByFloat(pendingRiskKey, -riskToRelease);
                        }
                        tradeContext.status = 'ACTIVE';
                        await redisClient.set(tradeId, JSON.stringify(tradeContext));
                        sendTelegramMessage(`[Sub-${tradeContext.subAccountId}] ▶️ *Pozicija Atidaryta ir Apsaugota*\n\n*Pora:* \`${tradeContext.ticker}\`\n*Trade ID:* \`${tradeId}\``);
                    } else {
                        sendTelegramMessage(`[Sub-${tradeContext.subAccountId}] ‼️ *KRITINĖ KLAIDA*\n\n` +
                            `*Pora:* \`${tradeContext.ticker}\`\n*Problema:* Nepavyko nustatyti SL/TP!\n` +
                            `*Bybit Atsakymas:* \`${setStopResponse.retMsg}\`\n*Trade ID:* \`${tradeId}\`\n\n*REIKALINGAS RANKINIS ĮSIKIŠIMAS!*`);
                    }
                    break;
                }
                case 'TRADE_CLOSED': {
                    const closePrice = parseFloat(data.closePrice);
                    const entryPrice = parseFloat(tradeContext.entryPrice);
                    const qty = parseFloat(tradeContext.qty);
                    const pnlUSD = (closePrice - entryPrice) * qty * (tradeContext.direction === 'long' ? 1 : -1);

                    await appendToSheet([
                        new Date().toISOString(), tradeContext.ticker, tradeContext.direction.toUpperCase(),
                        tradeContext.patternName, data.outcome, tradeContext.entryPrice,
                        data.closePrice, '', pnlUSD.toFixed(2), tradeId
                    ]);

                    await redisClient.del(tradeId);
                    await redisClient.sRem('active_trades', tradeId);
                    await redisClient.sRem(activePositionsSetKey, positionKey);

                    sendTelegramMessage(`[Sub-${tradeContext.subAccountId}] 📈 *Sandoris Užfiksuotas Žurnale*\n\n*Pora:* \`${tradeContext.ticker}\`\n*Rezultatas:* \`${data.outcome}\`\n*P/L:* \`$${pnlUSD.toFixed(2)}\`\n*Trade ID:* \`${tradeId}\``);
                    break;
                }
            }
        }
    } catch (error) {
        console.error(`❌ KLAIDA APDOROJANT UŽDUOTĮ ${job.id} (Trade ID: ${tradeId}):`, error.message, error.stack);
        sendTelegramMessage(`🆘 *Boto Vidinė Klaida (Worker)*\n\n*Problema:* \`${error.message}\`\n*Trade ID:* \`${tradeId}\``);
        throw error; // Svarbu, kad BullMQ žinotų, jog užduotis nepavyko.
    }
}
