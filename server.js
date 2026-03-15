const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── ENV VARIABLES ──
const STOCK_SHEET_URL = process.env.STOCK_SHEET_URL || '';
const SHOP_SHEET_URL  = process.env.SHOP_SHEET_URL  || '';
const INBOX_SHEET_URL = process.env.INBOX_SHEET_URL || '';
const N8N_REPLY_URL   = process.env.N8N_REPLY_URL   || '';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || 'minsah2024';


// ════════════════════════════════
// IN-MEMORY CACHE (no Redis needed)
// ════════════════════════════════
const CACHE_TTL   = parseInt(process.env.CACHE_TTL_MS)  || 30000; // 30s default
const SHOP_TTL    = parseInt(process.env.SHOP_TTL_MS)   || 60000; // 60s for shop
const INBOX_TTL   = parseInt(process.env.INBOX_TTL_MS)  || 15000; // 15s for inbox

const _cache = {};

function getCache(key) {
  const entry = _cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) {
    delete _cache[key];
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttl) {
  _cache[key] = { data, ts: Date.now(), ttl };
}

function clearCache(key) {
  if (key) delete _cache[key];
  else Object.keys(_cache).forEach(k => delete _cache[k]);
}

// ════════════════════════════════
// MIDDLEWARE — ORDER MATTERS
// ════════════════════════════════

// ✅ CORS সবার আগে
app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      'https://stock.minsahbeauty.cloud',
      'https://shop.minsahbeauty.cloud',
      'http://localhost:3000',
      'http://localhost:4000',
    ];
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // dev এ সব allow
    }
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── ADMIN AUTH ──
function adminOnly(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Safe fetch — JSON parse fail করলে crash নয় ──
async function safeFetch(url, options = {}) {
  const r    = await fetch(url, options);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch(e) {
    throw new Error('Apps Script non-JSON response: ' + text.slice(0, 300));
  }
}

// ════════════════════════════════
// STOCK ROUTES (Admin only)
// ════════════════════════════════

// GET all data
app.get('/api/stock', adminOnly, async (req, res) => {
  if (!STOCK_SHEET_URL) return res.status(503).json({ error: 'STOCK_SHEET_URL not configured' });
  // force=1 দিলে cache skip করে fresh data আনবে
  const force = req.query.force === '1';
  if (!force) {
    const cached = getCache('stock');
    if (cached) return res.json(cached);
  }
  try {
    const d = await safeFetch(`${STOCK_SHEET_URL}?action=getAll&t=${Date.now()}`);
    setCache('stock', d, CACHE_TTL);
    res.json(d);
  } catch(e) {
    console.error('[stock getAll]', e.message);
    // cache থাকলে stale data দাও — crash এর চেয়ে ভালো
    const stale = getCache('stock');
    if (stale) return res.json(stale);
    res.status(500).json({ error: 'Sheet error', detail: e.message });
  }
});

// ✅ GET write — admin.html এর পুরনো api() function এর জন্য (backward compat)
app.get('/api/stock/write', adminOnly, async (req, res) => {
  if (!STOCK_SHEET_URL) return res.status(503).json({ error: 'STOCK_SHEET_URL not configured' });
  try {
    const params = new URLSearchParams(req.query);
    const d = await safeFetch(`${STOCK_SHEET_URL}?${params}`);
    clearCache('stock'); // write হলে cache clear — পরের GET এ fresh data
    res.json(d);
  } catch(e) {
    console.error('[stock write GET]', e.message);
    res.status(500).json({ error: 'Sheet error', detail: e.message });
  }
});

// ✅ POST write — নতুন fixed api() function এর জন্য
app.post('/api/stock/write', adminOnly, async (req, res) => {
  if (!STOCK_SHEET_URL) return res.status(503).json({ error: 'STOCK_SHEET_URL not configured' });
  try {
    const params = new URLSearchParams(req.body);
    const d = await safeFetch(`${STOCK_SHEET_URL}?${params}`);
    clearCache('stock'); // write হলে cache clear
    res.json(d);
  } catch(e) {
    console.error('[stock write POST]', e.message);
    res.status(500).json({ error: 'Sheet error', detail: e.message });
  }
});

// ════════════════════════════════
// SHOP ROUTES (Public)
// ════════════════════════════════

// GET products — buy price লুকানো
app.get('/api/shop/products', async (req, res) => {
  if (!SHOP_SHEET_URL) return res.status(503).json({ error: 'SHOP_SHEET_URL not configured' });
  const cached = getCache('shop_products');
  if (cached) return res.json(cached);
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
        // buyprice ইচ্ছাকৃতভাবে বাদ
      }));
    const result = { products };
    setCache('shop_products', result, SHOP_TTL);
    res.json(result);
  } catch(e) {
    console.error('[shop products]', e.message);
    const stale = getCache('shop_products');
    if (stale) return res.json(stale);
    res.status(500).json({ error: 'Sheet error', detail: e.message });
  }
});

// ✅ GET order — shop.html থেকে order দেওয়ার জন্য
app.get('/api/shop/order', async (req, res) => {
  if (!SHOP_SHEET_URL) return res.status(503).json({ error: 'SHOP_SHEET_URL not configured' });
  const { customer, total } = req.query;
  if (!customer || !total) {
    return res.status(400).json({ error: 'customer and total required' });
  }
  try {
    const params = new URLSearchParams(req.query);
    const d = await safeFetch(`${SHOP_SHEET_URL}?${params}`);
    clearCache('shop_products'); // order হলে stock cache clear
    res.json(d);
  } catch(e) {
    console.error('[shop order]', e.message);
    res.status(500).json({ error: 'Order failed', detail: e.message });
  }
});

// ✅ POST order — alternative
app.post('/api/shop/order', async (req, res) => {
  if (!SHOP_SHEET_URL) return res.status(503).json({ error: 'SHOP_SHEET_URL not configured' });
  try {
    const params = new URLSearchParams(req.body);
    const d = await safeFetch(`${SHOP_SHEET_URL}?${params}`);
    res.json(d);
  } catch(e) {
    console.error('[shop order POST]', e.message);
    res.status(500).json({ error: 'Order failed', detail: e.message });
  }
});

// Track order by orderId or parcelId
app.get('/api/shop/track', async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  if (!SHOP_SHEET_URL) return res.status(503).json({ error: 'SHOP_SHEET_URL not configured' });
  try {
    const d = await safeFetch(`${SHOP_SHEET_URL}?action=getAll&t=${Date.now()}`);
    const orders = d.orders || [];
    const order  = orders.find(o =>
      (o.id      || '').toLowerCase() === orderId.toLowerCase() ||
      (o.parcelid|| '').toLowerCase() === orderId.toLowerCase()
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    // public fields only
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
    console.error('[shop track]', e.message);
    res.status(500).json({ error: 'Track error', detail: e.message });
  }
});

// ════════════════════════════════
// INBOX ROUTES (Admin only)
// ════════════════════════════════

// GET messages
app.get('/api/inbox', adminOnly, async (req, res) => {
  if (!INBOX_SHEET_URL) return res.status(503).json({ error: 'INBOX_SHEET_URL not configured' });
  // markRead বা অন্য action থাকলে cache skip
  const action = req.query.action || '';
  if (action === 'getMessages') {
    const cached = getCache('inbox_msgs');
    if (cached) return res.json(cached);
  }
  try {
    const params = new URLSearchParams(req.query);
    const d = await safeFetch(`${INBOX_SHEET_URL}?${params}`);
    if (action === 'getMessages') setCache('inbox_msgs', d, INBOX_TTL);
    else clearCache('inbox_msgs'); // markRead হলে cache clear
    res.json(d);
  } catch(e) {
    console.error('[inbox]', e.message);
    const stale = getCache('inbox_msgs');
    if (stale && action === 'getMessages') return res.json(stale);
    res.status(500).json({ error: 'Inbox error', detail: e.message });
  }
});

// POST reply via n8n
app.post('/api/inbox/reply', adminOnly, async (req, res) => {
  if (!N8N_REPLY_URL) return res.status(503).json({ error: 'N8N_REPLY_URL not configured' });
  try {
    const r    = await fetch(N8N_REPLY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(req.body)
    });
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); }
    catch(e) { d = { success: true, raw: text }; } // n8n plain text হলেও crash নয়
    res.json(d);
  } catch(e) {
    console.error('[inbox reply]', e.message);
    res.status(500).json({ error: 'Reply failed', detail: e.message });
  }
});

// ════════════════════════════════
// PUBLIC CONFIG
// ════════════════════════════════
app.get('/api/config', (req, res) => {
  res.json({
    whatsapp: WHATSAPP_NUMBER,
    hasStock: !!STOCK_SHEET_URL,
    hasShop:  !!SHOP_SHEET_URL,
    hasInbox: !!INBOX_SHEET_URL
  });
});

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({
    ok:           true,
    ts:           Date.now(),
    hasStock:     !!STOCK_SHEET_URL,
    hasShop:      !!SHOP_SHEET_URL,
    hasInbox:     !!INBOX_SHEET_URL,
    hasN8n:       !!N8N_REPLY_URL,
    cache: {
      stock:         !!_cache['stock'],
      shop_products: !!_cache['shop_products'],
      inbox_msgs:    !!_cache['inbox_msgs'],
      ttl_stock_ms:  CACHE_TTL,
      ttl_shop_ms:   SHOP_TTL,
      ttl_inbox_ms:  INBOX_TTL,
    }
  });
});

// Cache clear endpoint (admin only — useful after manual sheet edit)
app.post('/api/cache/clear', adminOnly, (req, res) => {
  clearCache();
  console.log('[cache] cleared manually');
  res.json({ ok: true, message: 'All cache cleared' });
});

// ════════════════════════════════
// HTML ROUTES
// ════════════════════════════════
app.get('/admin',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error('[server error]', err.message);
  res.status(500).json({ error: 'Server error', detail: err.message });
});

app.listen(PORT, () => {
  console.log(`✅ Minsah Proxy running on port ${PORT}`);
  console.log(`   Stock:  ${STOCK_SHEET_URL ? '✅ configured' : '❌ missing'}`);
  console.log(`   Shop:   ${SHOP_SHEET_URL  ? '✅ configured' : '❌ missing'}`);
  console.log(`   Inbox:  ${INBOX_SHEET_URL ? '✅ configured' : '❌ missing'}`);
  console.log(`   n8n:    ${N8N_REPLY_URL   ? '✅ configured' : '❌ missing'}`);
});
