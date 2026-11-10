import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';

app.get('/', (req, res) => res.json({ ok: true, service: 'boda-push' }));

app.post('/push', async (req, res) => {
  const { to, title, body, data } = req.body;
  if (!to || !title) return res.status(400).json({ error: 'to and title required' });

  try {
    const r = await fetch(EXPO_PUSH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        to,
        title,
        body: body || '',
        sound: 'default',
        priority: 'high',
        data: data || {},
      }),
    });
    const j = await r.json();
    res.json({ ok: true, expo: j });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`boda-push running on :${PORT}`));