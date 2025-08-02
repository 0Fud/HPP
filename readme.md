# Bybit Prekybos Boto Aplikacija

Šis projektas yra Node.js aplikacija, skirta automatizuotam prekybos botui, kuris sąveikauja su Bybit kriptovaliutų birža. Aplikacija naudoja Express.js, Telegraf (Telegram botui), BullMQ (užduočių eilei), Redis ir Bybit API.

Visas kodas yra refaktorintas į modulinę struktūrą, siekiant pagerinti skaitomumą, priežiūrą ir tolimesnį vystymą.

## Projekto Struktūra

Čia pateikiama projekto failų ir katalogų medžio struktūra:


.
├── node_modules/
├── services/
│   ├── bybit.js
│   ├── google.js
│   ├── redis.js
│   └── telegram.js
├── telegram_bot/
│   ├── actions.js
│   ├── commands.js
│   └── handlers.js
├── .env
├── app-setup.js
├── config.js
├── package.json
├── package-lock.json
├── server.js
├── utils.js
└── worker.js


## Failų ir Katalogų Paskirtis

Kiekvienas failas ir katalogas turi aiškiai apibrėžtą atsakomybę.

### Pagrindiniai Failai

* **`server.js`**: **Aplikacijos Paleidimo Taškas.** Šis failas yra atsakingas už visų modulių surinkimą ir aplikacijos paleidimą. Jis inicializuoja Express serverį, prijungia visus servisus, registruoja Telegram boto valdiklius ir paleidžia visą sistemą.
* **`config.js`**: **Centralizuota Konfigūracija.** Čia nuskaitomi visi aplinkos kintamieji iš `.env` failo, atliekamas jų patikrinimas ir eksportuojamos globalios konstantos (pvz., `ADMIN_ID`, `MAX_SUBACCOUNTS_NUM`).
* **`app-setup.js`**: **Pradinės Konfigūracijos Nustatymas.** Šiame faile yra logika, kuri programos paleidimo metu patikrina ir, jei reikia, nustato pradinius konfigūracijos parametrus (pvz., rizikos dydį) Redis duomenų bazėje.
* **`worker.js`**: **Foninių Užduočių Vykdytojas.** Čia yra pagrindinė verslo logika, kuri apdoroja prekybos signalus iš BullMQ eilės. Funkcija `handleJob` yra atsakinga už orderių kūrimą, atšaukimą, pozicijų valdymą ir sandorių fiksavimą.
* **`utils.js`**: **Pagalbinės Funkcijos.** Šiame faile sudėtos visos bendro naudojimo funkcijos, kurios yra reikalingos keliuose skirtinguose moduliuose, pavyzdžiui, `getAccountBalance`, `getInstrumentInfo`, `analyzeRedisSync` ir kt.

### `services/` Katalogas

Šiame kataloge yra moduliai, atsakingi už sąsajas su išorinėmis paslaugomis.

* **`bybit.js`**: Inicializuoja ir valdo Bybit API klientų (`RestClientV5`) instancijas visoms sub-sąskaitoms.
* **`google.js`**: Valdo visą integraciją su Google Sheets API, įskaitant kliento autorizavimą ir duomenų pridėjimą į žurnalą.
* **`redis.js`**: Inicializuoja Redis klientą, BullMQ užduočių eilę (`tradingQueue`) ir foninių užduočių darbininką (`worker`).
* **`telegram.js`**: Inicializuoja `Telegraf` boto instanciją ir valdo pranešimų siuntimą per specialią eilę, kuri apsaugo nuo Telegram API limitų viršijimo.

### `telegram_bot/` Katalogas

Šiame kataloge yra visa logika, susijusi su Telegram boto valdymu ir interakcija su vartotoju.

* **`commands.js`**: Apdoroja visas iš vartotojo gautas komandas (pvz., `/start`, `/apzvalga`, `/sistema`).
* **`actions.js`**: Apdoroja visus `inline` mygtukų paspaudimus (viskas, kas naudoja `bot.action()`).
* **`handlers.js`**: Apdoroja paprasto teksto žinutes, kurios nėra komandos. Tai naudojama, kai botas laukia specifinės vartotojo įvesties (pvz., keičiant konfigūracijos parametrą).

### Kiti Failai

* **`.env`**: **Aplinkos Kintamieji.** Čia saugomi visi konfidencialūs duomenys: API raktai, slaptažodžiai, ID ir kiti nustatymai. **Šis failas niekada neturėtų būti įtrauktas į versijų kontrolės sistemą (pvz., Git).**
* **`package.json` / `package-lock.json`**: Standartiniai Node.js failai, aprašantys projekto priklausomybes ir skriptus.

