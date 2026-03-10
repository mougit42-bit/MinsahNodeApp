const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARIABLES (Dokploy তে set করবে) ──
const STOCK_SHEET_URL  = process.env.STOCK_SHEET_URL  || '';
const SHOP_SHEET_URL   = process.env.SHOP_SHEET_URL   || '';
const INBOX_SHEET_URL  = process.env.INBOX_SHEET_URL  || '';
const N8N_REPLY_URL    = process.env.N8N_REPLY_URL    || '';
const WHATSAPP_NUMBER  = process.env.WHATSAPP_NUMBER  || '';
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || 'minsah2024';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CORS: শুধু নিজের domain থেকে ──
app.use(cors({
  origin: [
    'https://stock.minsahbeauty.cloud',
    'https://shop.minsahbeauty.cloud',
    'http://localhost:3000'
  ]
}));

// ── ADMIN AUTH MIDDLEWARE ──
function adminOnly(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ════════════════════════════════
// STOCK APP ROUTES (Admin only)
// ════════════════════════════════

// Get all inventory/orders/suppliers
app.get('/api/stock', adminOnly, async (req, res) => {
  if (!STOCK_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const url = `${STOCK_SHEET_URL}?action=getAll&t=${Date.now()}`;
    const r = await fetch(url);
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: 'Sheet error' });
  }
});

// Write to stock sheet (addProduct, addOrder, etc.)
app.get('/api/stock/write', adminOnly, async (req, res) => {
  if (!STOCK_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const params = new URLSearchParams(req.query);
    const r = await fetch(`${STOCK_SHEET_URL}?${params}`);
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: 'Sheet error' });
  }
});

// ════════════════════════════════
// SHOP APP ROUTES (Public)
// ════════════════════════════════

// Get products (only in-stock, no prices hidden)
app.get('/api/shop/products', async (req, res) => {
  if (!SHOP_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const r = await fetch(`${SHOP_SHEET_URL}?action=getAll&t=${Date.now()}`);
    const d = await r.json();
    // শুধু public fields পাঠাব — buy price লুকিয়ে রাখব
    const products = (d.inventory || [])
      .filter(p => (parseInt(p.qty) || 0) > 0)
      .map(p => ({
        id: p.id,
        name: p.name,
        brand: p.brand || '',
        variant: p.variant || '',
        size: p.size || '',
        country: p.country || '',
        image: p.image || p.img || '',
        price: parseFloat(p.sellprice || p.sell) || 0,
        qty: parseInt(p.qty) || 0,
        // buy price লুকানো ✅
      }));
    res.json({ products });
  } catch(e) {
    res.status(500).json({ error: 'Sheet error' });
  }
});

// Place order (public)
app.get('/api/shop/order', async (req, res) => {
  if (!SHOP_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const params = new URLSearchParams(req.query);
    const r = await fetch(`${SHOP_SHEET_URL}?${params}`);
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: 'Order failed' });
  }
});

// Track order (public)
app.get('/api/shop/track', async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  if (!SHOP_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const r = await fetch(`${SHOP_SHEET_URL}?action=getAll&t=${Date.now()}`);
    const d = await r.json();
    const orders = d.orders || [];
    const order = orders.find(o =>
      (o.id||'').toLowerCase() === orderId.toLowerCase() ||
      (o.parcelid||'').toLowerCase() === orderId.toLowerCase()
    );
    if (!order) return res.status(404).json({ error: 'Not found' });
    // শুধু public fields
    res.json({
      id: order.id,
      product: order.product,
      customer: order.customer,
      status: order.status,
      date: order.date,
      total: order.total,
      parcelid: order.parcelid || '',
      trackinglink: order.trackinglink || ''
    });
  } catch(e) {
    res.status(500).json({ error: 'Track error' });
  }
});

// ════════════════════════════════
// INBOX ROUTES (Admin only)
// ════════════════════════════════
app.get('/api/inbox', adminOnly, async (req, res) => {
  if (!INBOX_SHEET_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const params = new URLSearchParams(req.query);
    const r = await fetch(`${INBOX_SHEET_URL}?${params}`);
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: 'Inbox error' });
  }
});

app.post('/api/inbox/reply', adminOnly, async (req, res) => {
  if (!N8N_REPLY_URL) return res.status(503).json({ error: 'Not configured' });
  try {
    const r = await fetch(N8N_REPLY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: 'Reply error' });
  }
});

// ── CONFIG endpoint (public — শুধু non-secret info) ──
app.get('/api/config', (req, res) => {
  res.json({
    whatsapp: WHATSAPP_NUMBER,
    hasStock: !!STOCK_SHEET_URL,
    hasShop: !!SHOP_SHEET_URL,
    hasInbox: !!INBOX_SHEET_URL
  });
});

// ── Health check ──
app.get('/health', (req, res) => res.json({ ok: true }));

// ── Serve HTML files ──
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));

app.listen(PORT, () => console.log(`Minsah Proxy running on port ${PORT}`));
