// failas: services/google.js
// Paskirtis: Visos funkcijos, susijusios su Google Sheets API.

import { google } from 'googleapis';
import { GOOGLE_CREDENTIALS_PATH, GOOGLE_SHEET_ID } from '../config.js';
import { sendTelegramMessage } from './telegram.js';

/**
 * Sukuria ir grąžina autorizuotą Google Sheets API klientą.
 * Ši funkcija yra vidinė ir naudojama tik šiame modulyje.
 * @returns {Promise<import('googleapis').sheets_v4.Sheets>} Google Sheets kliento objektas.
 */
async function getSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        keyFile: GOOGLE_CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    return google.sheets({ version: 'v4', auth: authClient });
}

/**
 * Prideda eilutę duomenų į nurodytą Google Sheets dokumentą.
 * Įvykus klaidai, išsiunčia pranešimą į Telegram.
 * @param {Array<string|number>} rowData - Duomenų masyvas, kurį reikia įrašyti.
 */
export async function appendToSheet(rowData) {
    try {
        const sheets = await getSheetsClient();
        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Sheet1!A1', // Nurodo, kad reikia pridėti po paskutinės eilutės
            valueInputOption: 'USER_ENTERED',
            resource: { values: [rowData] },
        });
    } catch (error) {
        console.error('❌ Klaida rašant į Google Sheets:', error.message);
        // Informuojama apie klaidą per Telegram
        sendTelegramMessage(`🆘 *Google Sheets Klaida*\n\nNepavyko įrašyti sandorio į žurnalą.\n*Priežastis:* \`${error.message}\``);
    }
}
