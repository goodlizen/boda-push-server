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

const JS_DAY_TO_INDEX = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 };

function toLocalDateMidnight(d) {
  if (!d) return new Date();
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return new Date();
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/**
 * Accurately compute bike finances based on calendar days:
 * - Starts from registration date (`bike.startDate`).
 * - Only accumulates past days up to yesterday midnight (today 00:00:00).
 * - Today is not debt until 12 at night.
 */
function computeBikeFinancials(bike, targetDate = new Date()) {
  const schedule = bike.schedule || { amount: 0, days: [true, true, true, true, true, true, false] };
  const amount = Number(schedule.amount) || 0;
  const days = schedule.days || [true, true, true, true, true, true, false];

  const start = toLocalDateMidnight(bike.startDate || targetDate);
  const todayMidnight = toLocalDateMidnight(targetDate);

  let pastExpected = 0;
  let pastDaysCount = 0;

  if (amount > 0 && start < todayMidnight) {
    const cur = new Date(start.getTime());
    while (cur < todayMidnight) {
      const jsDay = cur.getDay();
      const idx = JS_DAY_TO_INDEX[jsDay];
      if (days[idx]) {
        pastExpected += amount;
        pastDaysCount++;
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  const totalPaid = (bike.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const totalExpense = (bike.expenses || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const balance = totalPaid - pastExpected;
  const debt = balance < 0 ? Math.abs(balance) : 0;

  return {
    totalPaid,
    totalExpense,
    pastExpected,
    pastDaysCount,
    balance,
    debt,
  };
}

// --- 1. GET ALL BIKES FROM SERVER ---
app.get('/bikes', (req, res) => {
  res.json({ ok: true, bikes: db.data.bikes || [] });
});

// --- 2. RECORD PAYMENT DIRECTLY TO SERVER ---
app.post('/add-payment', async (req, res) => {
  const { bikeId, amount, date } = req.body;
  if (!bikeId || amount === undefined) {
    return res.status(400).json({ error: 'bikeId and amount required' });
  }

  const bike = (db.data.bikes || []).find(b => String(b.id) === String(bikeId));
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  if (!bike.payments) bike.payments = [];
  const payment = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    amount: parseFloat(amount),
    date: date || new Date().toISOString(),
  };

  bike.payments.push(payment);
  await db.write();
  res.json({ ok: true, bike, payment });
});

// --- 3. ADD NEW BIKE TO SERVER ---
app.post('/add-bike', async (req, res) => {
  const { plate, name, phone, schedule, startDate, serviceDate, id } = req.body;
  if (!plate || !name) {
    return res.status(400).json({ error: 'plate and name required' });
  }

  const newBike = {
    id: id || Date.now(),
    plate: plate.trim().toUpperCase(),
    name: name.trim(),
    phone: phone ? phone.trim() : '',
    payments: [],
    expenses: [],
    schedule: schedule || { amount: 250, days: [true, true, true, true, true, true, false] },
    startDate: startDate || new Date().toISOString(),
    serviceDate: serviceDate || 15,
  };

  if (!db.data.bikes) db.data.bikes = [];
  db.data.bikes.push(newBike);
  await db.write();
  res.json({ ok: true, bike: newBike });
});

// --- 4. UPDATE BIKE ON SERVER ---
app.post('/update-bike', async (req, res) => {
  const { id, plate, name, phone, schedule, startDate, serviceDate } = req.body;
  const bike = (db.data.bikes || []).find(b => String(b.id) === String(id));
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  if (plate) bike.plate = plate.trim().toUpperCase();
  if (name) bike.name = name.trim();
  if (phone !== undefined) bike.phone = phone.trim();
  if (schedule) bike.schedule = schedule;
  if (startDate) bike.startDate = startDate;
  if (serviceDate !== undefined) bike.serviceDate = serviceDate;

  await db.write();
  res.json({ ok: true, bike });
});

// --- 5. DELETE BIKE FROM SERVER ---
app.delete('/bikes/:id', async (req, res) => {
  const { id } = req.params;
  const beforeLen = (db.data.bikes || []).length;
  db.data.bikes = (db.data.bikes || []).filter(b => String(b.id) !== String(id));
  if (db.data.bikes.length === beforeLen) {
    return res.status(404).json({ error: 'Bike not found' });
  }
  await db.write();
  res.json({ ok: true });
});

// --- 6. FULL SYNC DATA (BACKUP / BULK SYNC) ---
app.post('/sync', async (req, res) => {
  const { bikes } = req.body;
  if (!bikes) return res.status(400).json({ error: 'No bikes provided' });
  
  db.data.bikes = bikes;
  await db.write();
  res.json({ ok: true, message: 'Data synced' });
});

// --- 7. ADD EXPENSE ---
app.post('/add-expense', async (req, res) => {
  const { bikeId, amount, description } = req.body;
  const bike = (db.data.bikes || []).find(b => String(b.id) === String(bikeId));
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  if (!bike.expenses) bike.expenses = [];
  
  const expense = {
    id: Date.now().toString(),
    amount: parseFloat(amount),
    description: description || 'Service/Maintenance',
    date: new Date().toISOString()
  };
  bike.expenses.push(expense);

  await db.write();
  res.json({ ok: true, expenses: bike.expenses, expense });
});

// --- 8. GET STATISTICS (Filtered by Month + All-Time Balances + Rider Details) ---
app.get('/stats', (req, res) => {
  const monthStr = req.query.month || new Date().toISOString().slice(0, 7); 
  const [year, month] = monthStr.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();

  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const isCurrentMonth = now.toISOString().slice(0, 7) === monthStr;

  const bikesData = (db.data.bikes || []).map(bike => {
    const monthlyPayments = (bike.payments || []).filter(p => p.date && p.date.startsWith(monthStr));
    const totalIncome = monthlyPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);

    const monthlyExpenses = (bike.expenses || []).filter(e => e.date && e.date.startsWith(monthStr));
    const totalExpense = monthlyExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    // Compute expected numbers for this month
    let expectedFullMonth = 0;
    let expectedUpToYesterday = 0;
    const bikeStartDate = toLocalDateMidnight(bike.startDate || new Date(2000, 0, 1));
    const scheduleAmount = Number(bike.schedule?.amount) || 0;
    const scheduleDays = bike.schedule?.days || [true, true, true, true, true, true, false];

    if (scheduleAmount > 0) {
      for (let d = 1; d <= daysInMonth; d++) {
        const checkDate = new Date(year, month - 1, d);
        if (checkDate >= bikeStartDate) {
          const jsDay = checkDate.getDay();
          const idx = JS_DAY_TO_INDEX[jsDay];
          if (scheduleDays[idx]) {
            expectedFullMonth += scheduleAmount;
            const isPastDay = isCurrentMonth ? (checkDate < todayMidnight) : checkDate <= todayMidnight;
            if (isPastDay) expectedUpToYesterday += scheduleAmount;
          }
        }
      }
    }

    const fin = computeBikeFinancials(bike, now);

    return {
      id: bike.id,
      name: bike.name,
      plate: bike.plate,
      phone: bike.phone,
      startDate: bike.startDate,
      schedule: bike.schedule,
      payments: bike.payments || [],
      expenses: bike.expenses || [],
      totalIncome,
      totalExpense,
      netProfit: totalIncome - totalExpense,
      expectedFullMonth,
      expectedUpToYesterday,
      balance: fin.balance,
      debt: fin.debt,
      totalPaidAllTime: fin.totalPaid,
      totalExpenseAllTime: fin.totalExpense,
      pastExpected: fin.pastExpected,
    };
  });

  const grandTotalIncome = bikesData.reduce((s, b) => s + b.totalIncome, 0);
  const grandTotalExpense = bikesData.reduce((s, b) => s + b.totalExpense, 0);
  const grandNetProfit = grandTotalIncome - grandTotalExpense;
  const grandBalance = bikesData.reduce((s, b) => s + b.balance, 0);
  const grandDebt = bikesData.reduce((s, b) => s + b.debt, 0);

  res.json({
    month: monthStr,
    bikes: bikesData,
    summary: {
      income: grandTotalIncome,
      expense: grandTotalExpense,
      profit: grandNetProfit,
      balance: grandBalance,
      debt: grandDebt,
    }
  });
});

// --- 9. SEND PUSH NOTIFICATION ---
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

// --- 10. SEND SINGLE SMS TO RIDER ---
app.post('/send-sms', async (req, res) => {
  const { phone, message, bikeId } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  
  let formattedPhone = phone.trim();
  if (!formattedPhone.startsWith('+')) formattedPhone = '+' + formattedPhone;

  try {
    const smsRes = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEXTBEE_API_KEY },
      body: JSON.stringify({ recipients: [formattedPhone], message, deviceId: TEXTBEE_DEVICE_ID }),
    });

    const data = await smsRes.json().catch(() => ({}));
    if (smsRes.ok) {
      if (bikeId && db.data.lastSmsSent) {
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
        db.data.lastSmsSent[bikeId] = todayStr;
        await db.write();
      }
      return res.json({ ok: true, data });
    }
    return res.status(smsRes.status).json({ ok: false, error: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- 11. SEND DAILY SMS REMINDERS (Only for riders who have overdue debt) ---
app.post('/daily-sms', async (req, res) => {
  const bikes = db.data.bikes || [];
  const results = [];
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }); 

  if (!db.data.lastSmsSent) db.data.lastSmsSent = {};

  for (const bike of bikes) {
    if (!bike.schedule || !bike.schedule.amount) continue;
    if (db.data.lastSmsSent[bike.id] === todayStr) continue; 
    
    // Compute past debt up to yesterday midnight (today is not debt until 12 at night)
    const fin = computeBikeFinancials(bike);
    
    // If rider has no overdue debt (balance >= 0), don't send reminder
    if (fin.balance >= 0) {
      continue;
    }

    const debtOwed = fin.debt;
    let phone = (bike.phone || '').trim();
    if (!phone) continue;
    if (!phone.startsWith('+')) phone = '+' + phone;

    const message = `Habari ${bike.name}, unadaiwa KSh ${Math.round(debtOwed).toLocaleString()} kwa pikipiki ${bike.plate}. Tafadhali lipa salio lako kwa wakati. Asante.`;

    try {
      const smsRes = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': TEXTBEE_API_KEY },
        body: JSON.stringify({ recipients: [phone], message, deviceId: TEXTBEE_DEVICE_ID }),
      });
      
      if (smsRes.ok) {
        db.data.lastSmsSent[bike.id] = todayStr;
        results.push({ plate: bike.plate, status: 'sent', debt: debtOwed });
      } else {
        const errText = await smsRes.text().catch(() => '');
        results.push({ plate: bike.plate, status: 'failed', error: errText });
      }
    } catch (e) {
      results.push({ plate: bike.plate, status: 'failed', error: String(e) });
    }
  }
  await db.write();
  res.json({ ok: true, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
