import express from 'express';
import cors from 'cors';
import { JSONFilePreset } from 'lowdb/node';

const app = express();
app.use(cors());
app.use(express.json());

const defaultData = { bikes: [], lastSmsSent: {} };
const db = await JSONFilePreset('db.json', defaultData);

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';
const TEXTBEE_API_KEY = 'txb_NnDVNeC0AypsSX565SW4SZNSO5lBzsyw';
const TEXTBEE_DEVICE_ID = '6af42e534fd19e33896cd66a';

// --- 1. SYNC DATA FROM APP ---
app.post('/sync', async (req, res) => {
  const { bikes } = req.body;
  if (!bikes) return res.status(400).json({ error: 'No bikes provided' });
  
  db.data.bikes = bikes;
  await db.write();
  res.json({ ok: true, message: 'Data synced' });
});

// --- 2. ADD EXPENSE ---
app.post('/add-expense', async (req, res) => {
  const { bikeId, amount, description } = req.body;
  const bike = db.data.bikes.find(b => b.id === bikeId);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  if (!bike.expenses) bike.expenses = [];
  
  bike.expenses.push({
    id: Date.now().toString(),
    amount: parseFloat(amount),
    description: description || 'Service/Maintenance',
    date: new Date().toISOString()
  });

  await db.write();
  res.json({ ok: true, expenses: bike.expenses });
});

// --- 3. GET STATISTICS (Filtered by Month) ---
app.get('/stats', (req, res) => {
  const monthStr = req.query.month || new Date().toISOString().slice(0, 7); 
  const [year, month] = monthStr.split('-');
  const daysInMonth = new Date(year, month, 0).getDate();
  
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const isCurrentMonth = now.toISOString().slice(0, 7) === monthStr;

  const bikesData = db.data.bikes.map(bike => {
    // 1. Income & Expenses for this month
    const monthlyPayments = (bike.payments || []).filter(p => p.date.startsWith(monthStr));
    const totalIncome = monthlyPayments.reduce((s, p) => s + p.amount, 0);

    const monthlyExpenses = (bike.expenses || []).filter(e => e.date.startsWith(monthStr));
    const totalExpense = monthlyExpenses.reduce((s, e) => s + e.amount, 0);

    // 2. Calculate Expected & Balance
    let expectedAmount = 0; 
    let missedAmount = 0;   

    // If the bike doesn't have a startDate, assume it started at the beginning of time
    const bikeStartDate = bike.startDate ? new Date(bike.startDate) : new Date(2000, 0, 1);

    if (bike.schedule && bike.schedule.amount > 0) {
      for (let d = 1; d <= daysInMonth; d++) {
        const checkDate = new Date(year, month - 1, d);
        
        if (checkDate >= bikeStartDate) {
          const jsDay = checkDate.getDay();
          const idx = jsDay === 0 ? 6 : jsDay - 1; 
          
          if (bike.schedule.days[idx]) {
            expectedAmount += bike.schedule.amount;

            // Only count as debt if the day is fully over (yesterday and before)
            const isPastDay = isCurrentMonth ? (checkDate < todayMidnight) : true;
            if (isPastDay) {
              missedAmount += bike.schedule.amount;
            }
          }
        }
      }
    }

    const balance = totalIncome - missedAmount;

    return {
      id: bike.id,
      name: bike.name,
      plate: bike.plate,
      totalIncome,
      totalExpense,
      netProfit: totalIncome - totalExpense,
      expectedAmount,
      balance
    };
  });

  const grandTotalIncome = bikesData.reduce((s, b) => s + b.totalIncome, 0);
  const grandTotalExpense = bikesData.reduce((s, b) => s + b.totalExpense, 0);
  const grandNetProfit = grandTotalIncome - grandTotalExpense;
  const grandBalance = bikesData.reduce((s, b) => s + b.balance, 0);

  res.json({
    month: monthStr,
    bikes: bikesData,
    summary: {
      income: grandTotalIncome,
      expense: grandTotalExpense,
      profit: grandNetProfit,
      balance: grandBalance
    }
  });
});

// --- 4. SEND PUSH NOTIFICATION ---
app.post('/push', async (req, res) => {
  const { to, title, body, data } = req.body;
  if (!to || !title) return res.status(400).json({ error: 'to and title required' });
  try {
    const r = await fetch(EXPO_PUSH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ to, title, body: body || '', sound: 'default', priority: 'high', data: data || {} }),
    });
    res.json({ ok: true, expo: await r.json() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- 5. SEND DAILY SMS ---
app.post('/daily-sms', async (req, res) => {
  const bikes = db.data.bikes;
  const results = [];
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }); 

  for (const bike of bikes) {
    if (!bike.schedule || bike.schedule.amount === 0) continue;
    if (db.data.lastSmsSent[bike.id] === todayStr) continue; 
    
    // Calculate missed balance (Up to yesterday)
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStr = now.toISOString().slice(0, 7);
    const [year, month] = monthStr.split('-');
    
    let missedAmount = 0;
    const bikeStartDate = bike.startDate ? new Date(bike.startDate) : new Date(2000, 0, 1);

    for (let d = 1; d <= now.getDate(); d++) {
      const checkDate = new Date(year, month - 1, d);
      if (checkDate >= bikeStartDate && checkDate < todayMidnight) {
        const jsDay = checkDate.getDay();
        const idx = jsDay === 0 ? 6 : jsDay - 1; 
        if (bike.schedule.days[idx]) missedAmount += bike.schedule.amount;
      }
    }

    const paidThisMonth = (bike.payments || [])
      .filter(p => p.date.startsWith(monthStr))
      .reduce((s, p) => s + p.amount, 0);
      
    const currentBalance = paidThisMonth - missedAmount;
    const phone = bike.phone.startsWith('+') ? bike.phone : '+' + bike.phone;
    
    let message = currentBalance >= 0
      ? `Habari ${bike.name}, salio lako ni +KSh ${currentBalance}. Asante!`
      : `Habari ${bike.name}, unadaiwa KSh ${Math.abs(currentBalance)}. Tafadhali lipa kwa wakati.`;

    try {
      const smsRes = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': TEXTBEE_API_KEY },
        body: JSON.stringify({ recipients: [phone], message, deviceId: TEXTBEE_DEVICE_ID }),
      });
      
      if (smsRes.ok) {
        db.data.lastSmsSent[bike.id] = todayStr;
        results.push({ plate: bike.plate, status: 'sent' });
      }
    } catch (e) {
      results.push({ plate: bike.plate, status: 'failed' });
    }
  }
  await db.write();
  res.json({ ok: true, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));