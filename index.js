import express from 'express';
import cors from 'cors';
import { JSONFilePreset } from 'lowdb/node';

const app = express();
app.use(cors());
app.use(express.json());

// Setup Database
const defaultData = { bikes: [] };
const db = await JSONFilePreset('db.json', defaultData);

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';

// YOUR TEXTBEE KEYS
const TEXTBEE_API_KEY = 'txb_NnDVNeC0AypsSX565SW4SZNSO5lBzsyw';
const TEXTBEE_DEVICE_ID = '6af42e534fd19e33896cd66a';

// --- 1. SYNC DATA FROM APP ---
app.post('/sync', async (req, res) => {
  const { bikes } = req.body;
  if (!bikes) return res.status(400).json({ error: 'No bikes provided' });
  
  db.data.bikes = bikes;
  await db.write();
  res.json({ ok: true, message: 'Data synced to server' });
});

// --- 2. SEND PUSH NOTIFICATION ---
app.post('/push', async (req, res) => {
  const { to, title, body, data } = req.body;
  if (!to || !title) return res.status(400).json({ error: 'to and title required' });

  try {
    const r = await fetch(EXPO_PUSH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ to, title, body: body || '', sound: 'default', priority: 'high', data: data || {} }),
    });
    const j = await r.json();
    res.json({ ok: true, expo: j });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- 3. CALCULATE BALANCE ---
function calculateBalance(bike) {
  const amount = bike.schedule?.amount || 0;
  const days = bike.schedule?.days || [true, true, true, true, true, true, true];
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  let expected = 0;

  for (let d = 1; d <= now.getDate(); d++) {
    const date = new Date(y, m, d);
    const jsDay = date.getDay(); // 0=Sun, 1=Mon...
    const idx = jsDay === 0 ? 6 : jsDay - 1; // Convert to Mon-Sun index
    if (days[idx]) expected += amount;
  }

  const paid = (bike.payments || [])
    .filter(p => {
      const d = new Date(p.date);
      return d.getMonth() === m && d.getFullYear() === y;
    })
    .reduce((s, p) => s + p.amount, 0);

  return { expected, paid, balance: paid - expected };
}

// --- 4. SEND DAILY SMS (Triggered by Cron) ---
app.post('/daily-sms', async (req, res) => {
  const bikes = db.data.bikes;
  const results = [];

  for (const bike of bikes) {
    const { balance, expected, paid } = calculateBalance(bike);
    if (expected === 0) continue; 

    const phone = bike.phone.startsWith('+') ? bike.phone : '+' + bike.phone;
    
    // Message logic
    const message = balance >= 0
      ? `Habari ${bike.name}, leo umelipa KSh ${paid} kati ya KSh ${expected}. Salio lako ni +KSh ${balance}. Asante!`
      : `Habari ${bike.name}, leo umelipa KSh ${paid} kati ya KSh ${expected}. Unadaiwa KSh ${Math.abs(balance)}. Tafadhali lipa leo.`;

    try {
      const smsRes = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': TEXTBEE_API_KEY,
        },
        body: JSON.stringify({
          recipients: [phone],
          message: message,
          deviceId: TEXTBEE_DEVICE_ID,
        }),
      });
      
      const data = await smsRes.json();
      console.log(`SMS to ${bike.name}:`, data);
      results.push({ plate: bike.plate, status: 'sent' });
    } catch (e) {
      results.push({ plate: bike.plate, status: 'failed', error: String(e) });
    }
  }

  res.json({ ok: true, count: results.length, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));