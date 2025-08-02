// failas: services/redis.js
// Paskirtis: Inicializuoja ir eksportuoja redisClient, tradingQueue ir worker instancijas.

import { createClient } from 'redis';
import { Queue, Worker } from 'bullmq';
import { REDIS_URL } from '../config.js';
import { handleJob } from '../worker.js';

// --- REDIS KLIENTO INICIALIZAVIMAS ---
// Sukuriamas Redis klientas, naudojant URL iš konfigūracijos.
export const redisClient = createClient({ url: REDIS_URL });

// Pridedamas event listeneris klaidoms gaudyti.
redisClient.on('error', err => console.error('❌ Redis Client Error', err));

// --- BULLMQ EILĖS IR WORKER'IO INICIALIZAVIMAS ---

// Sukuriama nauja užduočių eilė 'trading-signals'.
// Ji naudos tą patį Redis klientą prisijungimui.
export const tradingQueue = new Queue('trading-signals', {
    connection: { client: redisClient }
});

// Sukuriamas 'workeris', kuris apdoros užduotis iš 'trading-signals' eilės.
// Worker'is naudoja 'handleJob' funkciją (kuri bus worker.js faile) kaip pagrindinę logiką.
// Nustatomas apribojimas: ne daugiau kaip 1 užduotis per 150ms.
export const worker = new Worker('trading-signals', handleJob, {
    connection: { client: redisClient },
    limiter: { max: 1, duration: 150 },
});

// Worker'io event listeneriai, skirti stebėti užduočių būseną.
worker.on('completed', job => console.log(`✅ Užduotis ${job.id} sėkmingai įvykdyta.`));
worker.on('failed', (job, err) => console.error(`❌ Užduotis ${job.id} nepavyko:`, err.message));
