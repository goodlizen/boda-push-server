import express from 'express';
import cors from 'cors';
import { JSONFilePreset } from 'lowdb/node';

const app = express();
app.use(cors());
app.use(express.json());

// Setup Database (Added lastSmsSent to track daily sends)
const defaultData = { bikes: [], lastSmsSent: {} };
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

// --- 3. WEEKLY BALANCE CALCULATOR (Mon-Sun) ---
function calculateWeeklyBalance(bike) {
  const amount = bike.schedule?.amount || 0;
  const days = bike.schedule?.days || [true, true, true, true, true, true, true];
  
  const now = new Date();
  
  // 1. Find Monday of THIS week
  const dayOfWeek = now.getDay(); 
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setDate(now.getDate() - diffToMonday);
  startOfThisWeek.setHours(0,0,0,0);

  // 2. Find Monday of LAST week
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

  // 3. Expected for THIS week (Full Monday to Sunday)
  let expectedThisWeek = 0;
  let tempDate = new Date(startOfThisWeek);
  for (let i = 0; i < 7; i++) {
    const jsDay = tempDate.getDay(); 
    const idx = jsDay === 0 ? 6 : jsDay - 1; 
    if (days[idx]) expectedThisWeek += amount;
    tempDate.setDate(tempDate.getDate() + 1);
  }

  // 4. Paid THIS week
  const paidThisWeek = (bike.payments || [])
    .filter(p => {
      const d = new Date(p.date);
      return d >= startOfThisWeek && d <= now;
    })
    .reduce((s, p) => s + p.amount, 0);

  // 5. Expected for LAST week
  let expectedLastWeek = 0;
  let tempLastDate = new Date(startOfLastWeek);
  for (let i = 0; i < 7; i++) {
    const jsDay = tempLastDate.getDay();
    const idx = jsDay === 0 ? 6 : jsDay - 1;
    if (days[idx]) expectedLastWeek += amount;
    tempLastDate.setDate(tempLastDate.getDate() + 1);
  }

  // 6. Paid LAST week
  const paidLastWeek = (bike.payments || [])
    .filter(p => {
      const d = new Date(p.date);
      return d >= startOfLastWeek && d < startOfThisWeek;
    })
    .reduce((s, p) => s + p.amount, 0);

  // 7. Carry-over balance from last week
  const lastWeekBalance = paidLastWeek - expectedLastWeek;

  // 8. Final balance
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
  
  // Get today's date string in East Africa Time (e.g., "2026-11-12")
  // We use EAT timezone because you are in Kenya
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }); 

  for (const bike of bikes) {
    if (!bike.schedule || bike.schedule.amount === 0) continue;
    
    // 🛑 SAFETY LOCK: Check if we already sent an SMS to this bike today
    if (db.data.lastSmsSent[bike.id] === todayStr) {
      results.push({ plate: bike.plate, status: 'skipped (already sent today)' });
      continue; 
    }
    
    const { currentBalance } = calculateWeeklyBalance(bike);
    const phone = bike.phone.startsWith('+') ? bike.phone : '+' + bike.phone;
    
    // Swahili Message Logic
    let message = '';
    if (currentBalance >= 0) {
      message = `Habari ${bike.name}, salio lako la wiki ni +KSh ${currentBalance}. Umelipa vizuri, asante na uendelee hivyo.`;
    } else {
      message = `Habari ${bike.name}, salio lako la wiki ni -KSh ${Math.abs(currentBalance)}. Tafadhali lipa kwa wakati ili kuepuka usumbufu.`;
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
      
      if (smsRes.ok) {
        // ✅ Mark as sent for today
        db.data.lastSmsSent[bike.id] = todayStr;
        results.push({ plate: bike.plate, status: 'sent' });
      } else {
        results.push({ plate: bike.plate, status: 'failed to send' });
      }
      
    } catch (e) {
      results.push({ plate: bike.plate, status: 'failed', error: String(e) });
    }
  }

  // Save the database so it remembers who was texted today
  await db.write();

  res.json({ ok: true, count: results.length, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));