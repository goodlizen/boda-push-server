import express from 'express';
import cors from 'cors';
import { JSONFilePreset } from 'lowdb/node';
import mongoose from 'mongoose';

const app = express();
app.use(cors());
app.use(express.json());

// =========================================================================
// 1. DATABASE CONFIGURATION (MONGODB ATLAS OR LOWDB FALLBACK)
// =========================================================================
const MONGODB_URI = process.env.MONGODB_URI;
let useMongo = false;

const BikeSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  plate: { type: String, required: true },
  name: { type: String, required: true },
  phone: { type: String, default: '' },
  startDate: { type: String, default: () => new Date().toISOString() },
  serviceDate: { type: Number, default: 15 },
  schedule: {
    amount: { type: Number, default: 250 },
    days: { type: [Boolean], default: [true, true, true, true, true, true, false] },
  },
  payments: [{
    id: String,
    amount: Number,
    date: String,
  }],
  expenses: [{
    id: String,
    amount: Number,
    description: String,
    date: String,
  }],
}, { timestamps: true });

const MetaSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: {} },
});

const BikeModel = mongoose.model('Bike', BikeSchema);
const MetaModel = mongoose.model('Meta', MetaSchema);

const defaultData = { bikes: [], lastSmsSent: {} };
const db = await JSONFilePreset('db.json', defaultData);

if (MONGODB_URI) {
  try {
    await mongoose.connect(MONGODB_URI);
    useMongo = true;
    console.log('✅ Connected to MongoDB Atlas cloud database!');
  } catch (err) {
    console.error('⚠️ MongoDB Atlas connection error, using local fallback:', err.message);
  }
} else {
  console.log('ℹ️ Running on local storage. Set MONGODB_URI environment variable on Render for cloud persistence.');
}

// Remove any legacy mock seed bikes from database
const SEED_PLATES = new Set([
  'KMEA 123A', 'KMEB 456B', 'KMEC 789C', 'KMED 012D', 'KMEE 345E',
  'KMEF 678F', 'KMEG 901G', 'KMEH 234H', 'KMEI 567I', 'KMEJ 890J'
]);

async function cleanLegacySeedBikes() {
  if (useMongo && mongoose.connection.readyState === 1) {
    await BikeModel.deleteMany({ plate: { $in: Array.from(SEED_PLATES) } });
  } else if (db.data && db.data.bikes && db.data.bikes.length > 0) {
    const cleaned = db.data.bikes.filter(b => !SEED_PLATES.has(b.plate) && !(b.id >= 1 && b.id <= 10 && b.plate?.startsWith('KME')));
    if (cleaned.length !== db.data.bikes.length) {
      db.data.bikes = cleaned;
      await db.write();
    }
  }
}
await cleanLegacySeedBikes().catch(() => {});

// Database Abstraction Functions
async function getBikesList() {
  if (useMongo && mongoose.connection.readyState === 1) {
    return await BikeModel.find({}).lean();
  }
  return db.data.bikes || [];
}

async function setBikesList(bikes) {
  if (useMongo && mongoose.connection.readyState === 1) {
    await BikeModel.deleteMany({});
    if (bikes && bikes.length > 0) {
      await BikeModel.insertMany(bikes.map(b => ({ ...b, id: String(b.id) })));
    }
    return;
  }
  db.data.bikes = bikes;
  await db.write();
}

async function addBikeItem(newBike) {
  if (useMongo && mongoose.connection.readyState === 1) {
    const created = await BikeModel.create({ ...newBike, id: String(newBike.id) });
    return created.toObject();
  }
  if (!db.data.bikes) db.data.bikes = [];
  db.data.bikes.push(newBike);
  await db.write();
  return newBike;
}

async function updateBikeItem(id, updates) {
  if (useMongo && mongoose.connection.readyState === 1) {
    return await BikeModel.findOneAndUpdate(
      { id: String(id) },
      { $set: updates },
      { new: true, lean: true }
    );
  }
  const bike = (db.data.bikes || []).find(b => String(b.id) === String(id));
  if (!bike) return null;
  Object.assign(bike, updates);
  await db.write();
  return bike;
}

async function deleteBikeItem(id) {
  if (useMongo && mongoose.connection.readyState === 1) {
    await BikeModel.deleteOne({ id: String(id) });
    return;
  }
  db.data.bikes = (db.data.bikes || []).filter(b => String(b.id) !== String(id));
  await db.write();
}

async function addPaymentItem(bikeId, payment) {
  if (useMongo && mongoose.connection.readyState === 1) {
    return await BikeModel.findOneAndUpdate(
      { id: String(bikeId) },
      { $push: { payments: payment } },
      { new: true, lean: true }
    );
  }
  const bike = (db.data.bikes || []).find(b => String(b.id) === String(bikeId));
  if (!bike) return null;
  if (!bike.payments) bike.payments = [];
  bike.payments.push(payment);
  await db.write();
  return bike;
}

async function addExpenseItem(bikeId, expense) {
  if (useMongo && mongoose.connection.readyState === 1) {
    return await BikeModel.findOneAndUpdate(
      { id: String(bikeId) },
      { $push: { expenses: expense } },
      { new: true, lean: true }
    );
  }
  const bike = (db.data.bikes || []).find(b => String(b.id) === String(bikeId));
  if (!bike) return null;
  if (!bike.expenses) bike.expenses = [];
  bike.expenses.push(expense);
  await db.write();
  return bike;
}

async function getLastSmsMap() {
  if (useMongo && mongoose.connection.readyState === 1) {
    const meta = await MetaModel.findOne({ key: 'lastSmsSent' }).lean();
    return meta?.value || {};
  }
  return db.data.lastSmsSent || {};
}

async function recordLastSmsSent(keys, todayStr) {
  if (useMongo && mongoose.connection.readyState === 1) {
    const current = (await MetaModel.findOne({ key: 'lastSmsSent' }).lean())?.value || {};
    for (const k of keys) {
      if (k) current[k] = todayStr;
    }
    await MetaModel.findOneAndUpdate(
      { key: 'lastSmsSent' },
      { $set: { value: current } },
      { upsert: true }
    );
    return;
  }
  if (!db.data.lastSmsSent) db.data.lastSmsSent = {};
  for (const k of keys) {
    if (k) db.data.lastSmsSent[k] = todayStr;
  }
  await db.write();
}

async function resetLastSmsSent() {
  if (useMongo && mongoose.connection.readyState === 1) {
    await MetaModel.findOneAndUpdate(
      { key: 'lastSmsSent' },
      { $set: { value: {} } },
      { upsert: true }
    );
    return;
  }
  db.data.lastSmsSent = {};
  await db.write();
}

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
app.get('/bikes', async (req, res) => {
  const bikes = await getBikesList();
  res.json({ ok: true, bikes, database: useMongo ? 'mongodb_atlas' : 'local_json' });
});

// --- 2. RECORD PAYMENT DIRECTLY TO SERVER ---
app.post('/add-payment', async (req, res) => {
  const { bikeId, amount, date } = req.body;
  if (!bikeId || amount === undefined) {
    return res.status(400).json({ error: 'bikeId and amount required' });
  }

  const payment = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    amount: parseFloat(amount),
    date: date || new Date().toISOString(),
  };

  const bike = await addPaymentItem(bikeId, payment);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  res.json({ ok: true, bike, payment });
});

// --- 3. ADD NEW BIKE TO SERVER ---
app.post('/add-bike', async (req, res) => {
  const { plate, name, phone, schedule, startDate, serviceDate, id } = req.body;
  if (!plate || !name) {
    return res.status(400).json({ error: 'plate and name required' });
  }

  const newBike = {
    id: String(id || Date.now()),
    plate: plate.trim().toUpperCase(),
    name: name.trim(),
    phone: phone ? phone.trim() : '',
    payments: [],
    expenses: [],
    schedule: schedule || { amount: 250, days: [true, true, true, true, true, true, false] },
    startDate: startDate || new Date().toISOString(),
    serviceDate: serviceDate || 15,
  };

  const bike = await addBikeItem(newBike);
  res.json({ ok: true, bike });
});

// --- 4. UPDATE BIKE ON SERVER ---
app.post('/update-bike', async (req, res) => {
  const { id, plate, name, phone, schedule, startDate, serviceDate } = req.body;
  const updates = {};
  if (plate) updates.plate = plate.trim().toUpperCase();
  if (name) updates.name = name.trim();
  if (phone !== undefined) updates.phone = phone.trim();
  if (schedule) updates.schedule = schedule;
  if (startDate) updates.startDate = startDate;
  if (serviceDate !== undefined) updates.serviceDate = serviceDate;

  const bike = await updateBikeItem(id, updates);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  res.json({ ok: true, bike });
});

// --- 5. DELETE BIKE FROM SERVER ---
app.delete('/bikes/:id', async (req, res) => {
  const { id } = req.params;
  await deleteBikeItem(id);
  res.json({ ok: true, message: `Bike ${id} deleted` });
});

// --- CLEAR ALL BIKES ---
app.post('/clear-bikes', async (req, res) => {
  await setBikesList([]);
  res.json({ ok: true, message: 'All bikes cleared' });
});

// --- 6. FULL SYNC DATA (BACKUP / BULK SYNC) ---
app.post('/sync', async (req, res) => {
  const { bikes } = req.body;
  if (!bikes) return res.status(400).json({ error: 'No bikes provided' });
  
  await setBikesList(bikes);
  res.json({ ok: true, message: 'Data synced' });
});

// --- 7. ADD EXPENSE ---
app.post('/add-expense', async (req, res) => {
  const { bikeId, amount, description } = req.body;
  const expense = {
    id: Date.now().toString(),
    amount: parseFloat(amount),
    description: description || 'Service/Maintenance',
    date: new Date().toISOString()
  };

  const bike = await addExpenseItem(bikeId, expense);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });

  res.json({ ok: true, expenses: bike.expenses, expense });
});

// --- 8. GET STATISTICS (Filtered by Month + All-Time Balances + Rider Details) ---
app.get('/stats', async (req, res) => {
  const monthStr = req.query.month || new Date().toISOString().slice(0, 7); 
  const [year, month] = monthStr.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();

  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const isCurrentMonth = now.toISOString().slice(0, 7) === monthStr;

  const rawBikes = await getBikesList();

  const bikesData = rawBikes.map(bike => {
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

// =========================================================================
// PRODUCTION RULE: STRICTLY 1 SMS PER BIKE / RIDER PER CALENDAR DAY
// Ensures each motorcycle rider receives at most 1 SMS per day.
// =========================================================================
const LIMIT_ONE_SMS_PER_BIKE_PER_DAY = true;

// --- 10. SEND SINGLE SMS TO RIDER ---
app.post('/send-sms', async (req, res) => {
  const { phone, message, bikeId } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  
  let formattedPhone = phone.trim();
  if (!formattedPhone.startsWith('+')) formattedPhone = '+' + formattedPhone;
  const normalizedPhone = formattedPhone.replace(/[^\d+]/g, '');

  const lastSmsMap = await getLastSmsMap();
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

  // Rate-limiting check: maximum 1 SMS per bike / phone per day
  if (LIMIT_ONE_SMS_PER_BIKE_PER_DAY) {
    const alreadySentPhone = lastSmsMap[normalizedPhone] === todayStr;
    const alreadySentBike = bikeId && lastSmsMap[String(bikeId)] === todayStr;

    if (alreadySentPhone || alreadySentBike) {
      return res.status(429).json({
        ok: false,
        limited: true,
        error: `Daily limit reached: Already sent 1 SMS to this bike/rider (${formattedPhone}) today (${todayStr}).`,
      });
    }
  }

  try {
    const smsRes = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TEXTBEE_API_KEY },
      body: JSON.stringify({ recipients: [formattedPhone], message, deviceId: TEXTBEE_DEVICE_ID }),
    });

    const data = await smsRes.json().catch(() => ({}));
    if (smsRes.ok) {
      // Record sent date for both phone number and bikeId for today
      await recordLastSmsSent([normalizedPhone, bikeId ? String(bikeId) : null], todayStr);
      return res.json({ ok: true, data });
    }
    return res.status(smsRes.status).json({ ok: false, error: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- 11. SEND DAILY SMS REMINDERS (Only for riders who have overdue debt) ---
app.post('/daily-sms', async (req, res) => {
  const bikes = await getBikesList();
  const results = [];
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }); 

  const lastSmsMap = await getLastSmsMap();

  for (const bike of bikes) {
    if (!bike.schedule || !bike.schedule.amount) continue;

    let phone = (bike.phone || '').trim();
    if (!phone) continue;
    if (!phone.startsWith('+')) phone = '+' + phone;
    const normalizedPhone = phone.replace(/[^\d+]/g, '');

    // Skip if bike or phone already received SMS today
    if (LIMIT_ONE_SMS_PER_BIKE_PER_DAY) {
      if (lastSmsMap[normalizedPhone] === todayStr || lastSmsMap[String(bike.id)] === todayStr) {
        results.push({ plate: bike.plate, status: 'skipped', reason: 'already sent today' });
        continue;
      }
    }

    // Compute past debt up to yesterday midnight (today is not debt until 12 at night)
    const fin = computeBikeFinancials(bike);
    
    // If rider has no overdue debt (balance >= 0), don't send reminder
    if (fin.balance >= 0) {
      continue;
    }

    const debtOwed = fin.debt;
    const message = `Habari ${bike.name}, unadaiwa KSh ${Math.round(debtOwed).toLocaleString()} kwa pikipiki ${bike.plate}. Tafadhali lipa salio lako kwa wakati. Asante.`;

    try {
      const smsRes = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': TEXTBEE_API_KEY },
        body: JSON.stringify({ recipients: [phone], message, deviceId: TEXTBEE_DEVICE_ID }),
      });
      
      if (smsRes.ok) {
        await recordLastSmsSent([normalizedPhone, String(bike.id)], todayStr);
        results.push({ plate: bike.plate, status: 'sent', debt: debtOwed });
      } else {
        const errText = await smsRes.text().catch(() => '');
        results.push({ plate: bike.plate, status: 'failed', error: errText });
      }
    } catch (e) {
      results.push({ plate: bike.plate, status: 'failed', error: String(e) });
    }
  }
  res.json({ ok: true, results });
});

// --- 12. RESET SMS LIMITS ---
app.post('/reset-sms-limits', async (req, res) => {
  await resetLastSmsSent();
  res.json({ ok: true, message: 'Daily SMS rate limits cleared.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
