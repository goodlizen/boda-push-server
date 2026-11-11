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

// --- 3. WEEKLY BALANCE CALCULATOR ---
function calculateWeeklyBalance(bike) {
  const amount = bike.schedule?.amount || 0;
  const days = bike.schedule?.days || [true, true, true, true, true, true, true];
  
  const now = new Date();
  
  // Get Monday of the current week
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - diffToMonday);
  startOfThisWeek.setHours(0,0,0,0);

  // Get Monday of last week
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

  // 1. Expected for THIS week (Monday up to today)
  let expectedThisWeek = 0;
  let tempDate = new Date(startOfThisWeek);
  while (tempDate <= now) {
    const jsDay = tempDate.getDay(); 
    const idx = jsDay === 0 ? 6 : jsDay - 1; 
    if (days[idx]) expectedThisWeek += amount;
    tempDate.setDate(tempDate.getDate() + 1);
  }

  // 2. Paid THIS week
  const paidThisWeek = (bike.payments || [])
    .filter(p => {
      const d = new Date(p.date);
      return d >= startOfThisWeek && d <= now;
    })
    .reduce((s, p) => s + p.amount, 0);

  // 3. Expected for LAST week (Full Monday to Sunday)
  let expectedLastWeek = 0;
  let tempLastDate = new Date(startOfLastWeek);
  for (let i = 0; i < 7; i++) {
    const jsDay = tempLastDate.getDay();
    const idx = jsDay === 0 ? 6 : jsDay - 1;
    if (days[idx]) expectedLastWeek += amount;
    tempLastDate.setDate(tempLastDate.getDate() + 1);
  }

  // 4. Paid LAST week
  const paidLastWeek = (bike.payments || [])
    .filter(p => {
      const d = new Date(p.date);
      return d >= startOfLastWeek && d < startOfThisWeek;
    })
    .reduce((s, p) => s + p.amount, 0);

  // 5. Calculate carry-over and current balance
  const lastWeekBalance = paidLastWeek - expectedLastWeek;
  const currentBalance = (paidThisWeek - expectedThisWeek) + lastWeekBalance;

  return { 
    expectedThisWeek, 
    paidThisWeek, 
    lastWeekBalance, 
    currentBalance 
  };
}

// --- 4. SEND DAILY SMS (Triggered by Cron) ---
app.post('/daily-sms', async (req, res) => {
  const bikes = db.data.bikes;
  const results = [];

  for (const bike of bikes) {
    // Skip if there is no schedule set
    if (!bike.schedule || bike.schedule.amount === 0) continue;
    
    const { currentBalance } = calculateWeeklyBalance(bike);
    const phone = bike.phone.startsWith('+') ? bike.phone : '+' + bike.phone;
    
    // Swahili Message Logic for Weekly Balance
    let message = '';
    if (currentBalance >= 0) {
      message = `Habari ${bike.name}, malipo yamepokelewa. Salio lako la wiki hii ni +KSh ${currentBalance}. Asante kwa kulipa kwa wakati.`;
    } else {
      message = `Habari ${bike.name}, malipo yamepokelewa. Unadaiwa KSh ${Math.abs(currentBalance)} kwa wiki hii. Tafadhali lipa kwa wakati ili kuepuka usumbufu.`;
    }

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