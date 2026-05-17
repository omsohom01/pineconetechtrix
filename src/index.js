const path = require('path');
const dotenv = require('dotenv');

// Load from project root (.env then .env.local override)
const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });
dotenv.config({ path: path.join(rootDir, '.env.local') });

const express = require('express');
const cors = require('cors');

const whatsappRoutes = require('./routes/whatsapp');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'OK', service: 'OutreachX WhatsApp Backend' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/whatsapp', whatsappRoutes);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`📱 WhatsApp Phone Number ID: ${process.env.WHATSAPP_PHONE_NUMBER_ID}`);
});
