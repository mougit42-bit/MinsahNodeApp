const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── ENV VARIABLES (Dokploy তে set করবে) ──
const STOCK_SHEET_URL = process.env.STOCK_SHEET_URL || '';
const SHOP_SHEET_URL  = process.env.SHOP_SHEET_URL  || '';
const INBOX_SHEET_URL = process.env.INBOX_SHEET_URL || '';
const N8N_REPLY_URL   = process.env.N8N_REPLY_URL   || '';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || 'minsah2024';

// ════════════════════════════════
// ✅ FIX 1: CORS সবার আগে
// ════════════════════════════════
app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      'https://stock.minsahbeauty.cloud',
      'https://shop.minsahbeauty.cloud',
      'http://localhost:3000',
      'http://localhost:4000', // ✅ FIX 4: dev port added
    ];
    // same-origin request এ origin undefined হয় — allow করো
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed: ' + origin));
    }
  },
  credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // ✅ static CORS এর পরে

// ── ADMIN AUTH MIDDLEWARE ──
function adminOnly(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Safe fetch helper — JSON parse failure ধরবে ──
async function safeFetch(url, options = {}) {
  const r = await fetch(url, options);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch(e) {
    // JSON না হলে error object return করো
    throw new Error('Non-JSON response: ' + text.slice(0, 200));
  }
}

// ════════════════════════════════
// STOCK APP ROUTES (Admin only)
// ════════════════════════════════

// Get all inventory/orders/suppliers
app.get('/api/stock', adminOnly, async (req, res) => {
  if (!STOCK_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const url = `${STOCK_SHEET_URL}?action=getAll&t=${Date.now()}`;
    const d = await safeFetch(url);
    res.json(d);
  } catch(e) {
    console.error('[stock] getAll error:', e.message);
    res.status(500).json({ error: 'Sheet error', detail: e.message });
  }
});

// ✅ FIX 2: Write — GET এবং POST দুটোই support
// GET: backward compat (existing calls)
app.get('/api/stock/write', adminOnly, async (req, res) => {
  if (!STOCK_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const params = new URLSearchParams(req.query);
    const d = await safeFetch(`${STOCK_SHEET_URL}?${params}`);
    res.json(d);
  } catch(e) {
    console.error('[stock] write GET error:', e.message);
    res.status(500).json({ error: 'Sheet error', detail: e.message });
  }
});

// POST: sensitive data URL এ না গিয়ে body তে যাবে
app.post('/api/stock/write', adminOnly, async (req, res) => {
  if (!STOCK_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const params = new URLSearchParams(req.body);
    const d = await safeFetch(`${STOCK_SHEET_URL}?${params}`);
    res.json(d);
  } catch(e) {
    console.error('[stock] write POST error:', e.message);
    res.status(500).json({ error: 'Sheet error', detail: e.message });
  }
});

// ════════════════════════════════
// SHOP APP ROUTES (Public)
// ════════════════════════════════

// Get products — শুধু in-stock, buy price লুকানো
app.get('/api/shop/products', async (req, res) => {
  if (!SHOP_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const d = await safeFetch(`${SHOP_SHEET_URL}?action=getAll&t=${Date.now()}`);
    const products = (d.inventory || [])
      .filter(p => (parseInt(p.qty) || 0) > 0)
      .map(p => ({
        id:      p.id,
        name:    p.name,
        brand:   p.brand   || '',
        variant: p.variant || '',
        size:    p.size    || '',
        country: p.country || '',
        image:   p.image   || p.img || '',
        price:   parseFloat(p.sellprice || p.sell) || 0,
        qty:     parseInt(p.qty) || 0,
        // ✅ buyprice লুকানো — কোনো field নেই
      }));
    res.json({ products });
  } catch(e) {
    console.error('[shop] products error:', e.message);
    res.status(500).json({ error: 'Sheet error', detail: e.message });
  }
});

// Place order (public)
// ✅ FIX 3: Basic validation যোগ করা হয়েছে
app.get('/api/shop/order', async (req, res) => {
  if (!SHOP_SHEET_URL) return res.status(503).json({ error: 'Not configured' });

  // Basic validation
  const { customer, total } = req.query;
  if (!customer || !total) {
    return res.status(400).json({ error: 'customer and total required' });
  }

  try {
    const params = new URLSearchParams(req.query);
    const d = await safeFetch(`${SHOP_SHEET_URL}?${params}`);
    res.json(d);
  } catch(e) {
    console.error('[shop] order error:', e.message);
    res.status(500).json({ error: 'Order failed', detail: e.message });
  }
});

// Track order (public)
app.get('/api/shop/track', async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  if (!SHOP_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const d = await safeFetch(`${SHOP_SHEET_URL}?action=getAll&t=${Date.now()}`);
    const orders = d.orders || [];
    const order = orders.find(o =>
      (o.id     || '').toLowerCase() === orderId.toLowerCase() ||
      (o.parcelid|| '').toLowerCase() === orderId.toLowerCase()
    );
    if (!order) return res.status(404).json({ error: 'Not found' });

    // ✅ শুধু public fields — private info লুকানো
    res.json({
      id:           order.id,
      product:      order.product,
      customer:     order.customer,
      status:       order.status,
      date:         order.date,
      total:        order.total,
      parcelid:     order.parcelid     || '',
      trackinglink: order.trackinglink || ''
    });
  } catch(e) {
    console.error('[shop] track error:', e.message);
    res.status(500).json({ error: 'Track error', detail: e.message });
  }
});

// ════════════════════════════════
// INBOX ROUTES (Admin only)
// ════════════════════════════════

app.get('/api/inbox', adminOnly, async (req, res) => {
  if (!INBOX_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const params = new URLSearchParams(req.query);
    const d = await safeFetch(`${INBOX_SHEET_URL}?${params}`);
    res.json(d);
  } catch(e) {
    console.error('[inbox] fetch error:', e.message);
    res.status(500).json({ error: 'Inbox error', detail: e.message });
  }
});

// ✅ FIX 5: n8n response non-JSON হলে crash করবে না
app.post('/api/inbox/reply', adminOnly, async (req, res) => {
  if (!N8N_REPLY_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const r = await fetch(N8N_REPLY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(req.body)
    });
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); }
    catch(e) { d = { success: true, raw: text }; } // ✅ plain text হলেও crash নয়
    res.json(d);
  } catch(e) {
    console.error('[inbox] reply error:', e.message);
    res.status(500).json({ error: 'Reply error', detail: e.message });
  }
});

// ── CONFIG endpoint (public — non-secret info only) ──
app.get('/api/config', (req, res) => {
  res.json({
    whatsapp: WHATSAPP_NUMBER,
    hasStock: !!STOCK_SHEET_URL,
    hasShop:  !!SHOP_SHEET_URL,
    hasInbox: !!INBOX_SHEET_URL
  });
});

// ── Health check ──
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ✅ FIX 7: Admin route — exact + wildcard দুটোই
app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);
app.get('/admin/*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);

// Fallback → shop
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'shop.html'))
);

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err.message);
  res.status(500).json({ error: 'Server error', detail: err.message });
});

app.listen(PORT, () =>
  console.log(`✅ Minsah Proxy running on port ${PORT}`)
);
