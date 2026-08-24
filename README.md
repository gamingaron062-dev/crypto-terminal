# Crypto Futures Intelligence — 24/7 Backend

Ye woh backend hai jo ab **hamesha chalega** — aapke phone ya browser tab band hone
se koi farq nahi padega. Scanning, Auto-Lock, aur TP/SL monitoring sab is server
par continuously chalti rahegi.

## Kya alag hai purane HTML tool se
- Analysis/scoring logic bilkul wahi hai (same fixed thresholds).
- Auto-Lock ab **default ON** hai aur server khud har 1 minute scan karta hai.
- Open locks ka mark price har 10 second check hota hai (fast TP/SL detection).
- Jab lock bane ya close ho, Telegram par turant message aata hai.
- `public/index.html` ek dashboard hai jo server se live data dikhata hai — koi bhi
  device se khol sakte hain, data hamesha up-to-date hoga.

## Step 1 — Telegram Bot Banayein (5 minute)
1. Telegram mein **@BotFather** ko message karein → `/newbot` → naam aur username
   set karein. Ye aapko ek **Bot Token** dega (jaisa `123456:ABC-DEF...`).
2. Apne naye bot ko koi bhi message bhejein (jaise "hi") taake wo aapko pehchan sake.
3. Browser mein ye URL kholein (token apna daal kar):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Response mein `"chat":{"id": 123456789 ...}` milega — yehi aapka **Chat ID** hai.

## Step 2 — Railway Par Deploy Karein
1. [railway.app](https://railway.app) par GitHub se sign up karein.
2. Ye poora `backend` folder ek naye GitHub repo mein push karein.
3. Railway mein **New Project → Deploy from GitHub repo** select karein, apna repo
   choose karein.
4. Railway khud `package.json` dekh kar `npm install && npm start` chala dega.
5. **Variables** tab mein jaake ye 2 environment variables add karein:
   - `TELEGRAM_BOT_TOKEN` = Step 1 ka token
   - `TELEGRAM_CHAT_ID` = Step 1 ka chat id
6. Deploy hone ke baad Railway aapko ek public URL dega (jaisa
   `https://yourapp.up.railway.app`) — yahi URL kholein to dashboard dikhega.

## Step 3 — Verify Karein
- Dashboard URL kholein → "Auto-Lock: ON" aur "Last scan" time dikhna chahiye.
- Kuch minute wait karein, Signal Desk table populate ho jayegi.
- Jab pehla lock bane, Telegram par notification aayegi.

## Persistence (zaroori note)
Locks/history/logs is folder ke `data/` mein JSON files mein save hote hain.
- **Normal restarts** (server crash/reboot) — data safe rehta hai.
- **Naya deploy/redeploy** (naya code push karna) — Railway ke free tier par
  filesystem reset ho sakta hai, purana data (locks history) khatam ho sakta hai.
- Agar aapko history hamesha permanent chahiye chahe kitni baar bhi redeploy karein,
  to Railway ka **Volume** feature attach karke `DATA_DIR` environment variable us
  volume ke path par set kar dein — phir data kabhi nahi mitega.

## Local Testing (optional, deploy se pehle)
```
cd backend
npm install
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx npm start
```
Phir browser mein `http://localhost:3000` kholein.

## Important
- Ye ab bhi decision-support tool hai — koi exchange order place nahi karta, aur
  koi bhi signal 100% guaranteed target-hit nahi hota.
- Agar aapko lagta hai signals bohot kam/zyada aa rahe hain, `analysis.js` ke top
  mein `MIN_SCORE` aur `STRONG_SCORE` constants adjust kar sakte hain.
