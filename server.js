const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const mongoose = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── ENV ──
const MONGODB_URL     = process.env.MONGODB_URL     || '';
const N8N_REPLY_URL   = process.env.N8N_REPLY_URL   || '';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';
const INBOX_SHEET_URL = process.env.INBOX_SHEET_URL || ''; // inbox এখনো sheet এ থাকবে (optional)

// ✅ SECURITY: hardcoded default নেই
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('❌ FATAL: ADMIN_PASSWORD env variable set নেই!');
  process.exit(1);
}
if (!MONGODB_URL) {
  console.error('❌ FATAL: MONGODB_URL env variable set নেই!');
  process.exit(1);
}

// ════════════════════════════════
// MONGOOSE SCHEMAS
// ════════════════════════════════

const inventorySchema = new mongoose.Schema({
  id:          { type: String, required: true, unique: true },
  name:        { type: String, default: '' },
  brand:       { type: String, default: '' },
  country:     { type: String, default: '' },
  variant:     { type: String, default: '' },
  size:        { type: String, default: '' },
  buyprice:    { type: Number, default: 0 },
  sellprice:   { type: Number, default: 0 },
  qty:         { type: Number, default: 0 },
  supplier:    { type: String, default: '' },
  lastbuydate: { type: String, default: '' },
  lowestbuy:   { type: Number, default: 0 },
  image:       { type: String, default: '' },
  totalsold:   { type: Number, default: 0 },
  lastsolddate:{ type: String, default: '' },
}, { timestamps: true });

const orderSchema = new mongoose.Schema({
  id:           { type: String, required: true, unique: true },
  parcelid:     { type: String, default: '' },
  trackinglink: { type: String, default: '' },
  customer:     { type: String, default: '' },
  phone:        { type: String, default: '' },
  product:      { type: String, default: '' },
  productid:    { type: String, default: '' },
  variant:      { type: String, default: '' },
  qty:          { type: Number, default: 1 },
  total:        { type: Number, default: 0 },
  status:       { type: String, default: 'pending' },
  date:         { type: String, default: '' },
  note:         { type: String, default: '' },
  items:        { type: Array,  default: [] },
  address:      { type: String, default: '' },
  district:     { type: String, default: '' },
  thana:        { type: String, default: '' },
}, { timestamps: true });

const supplierSchema = new mongoose.Schema({
  id:      { type: String, required: true, unique: true },
  name:    { type: String, default: '' },
  phone:   { type: String, default: '' },
  phone2:  { type: String, default: '' },
  phone3:  { type: String, default: '' },
  address: { type: String, default: '' },
}, { timestamps: true });

const restockSchema = new mongoose.Schema({
  id:            { type: String, required: true, unique: true },
  productid:     { type: String, default: '' },
  productname:   { type: String, default: '' },
  addedqty:      { type: Number, default: 0 },
  purchaseprice: { type: Number, default: 0 },
  supplier:      { type: String, default: '' },
  date:          { type: String, default: '' },
  note:          { type: String, default: '' },
}, { timestamps: true });

const Inventory = mongoose.model('Inventory', inventorySchema);
const Order     = mongoose.model('Order',     orderSchema);
const Supplier  = mongoose.model('Supplier',  supplierSchema);
const Restock   = mongoose.model('Restock',   restockSchema);

// ════════════════════════════════
// MONGODB CONNECT
// ════════════════════════════════
mongoose.connect(MONGODB_URL)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(e => { console.error('❌ MongoDB connection failed:', e.message); process.exit(1); });

// ════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════
app.use(cors({ origin: '*', credentials: true }));
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

// ── doc → plain object (MongoDB _id বাদ দিয়ে) ──
function clean(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  delete obj.__v;
  delete obj.createdAt;
  delete obj.updatedAt;
  return obj;
}
function cleanAll(docs) { return docs.map(clean); }

// ── safe fetch (inbox এর জন্য) ──
async function safeFetch(url) {
  const r    = await fetch(url);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('Non-JSON: ' + text.slice(0,200)); }
}

// ════════════════════════════════
// STOCK ROUTES — GET ALL
// ════════════════════════════════
app.get('/api/stock', adminOnly, async (req, res) => {
  try {
    const [inventory, orders, suppliers, restocks] = await Promise.all([
      Inventory.find().sort({ createdAt: -1 }),
      Order.find().sort({ createdAt: -1 }),
      Supplier.find().sort({ createdAt: -1 }),
      Restock.find().sort({ createdAt: -1 }),
    ]);
    res.json({
      inventory: cleanAll(inventory),
      orders:    cleanAll(orders),
      suppliers: cleanAll(suppliers),
      restocks:  cleanAll(restocks),
    });
  } catch(e) {
    console.error('[stock getAll]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════
// STOCK WRITE — POST
// ════════════════════════════════
app.post('/api/stock/write', adminOnly, async (req, res) => {
  const p = req.body;
  const action = p.action || '';

  try {

    // ── INVENTORY ──

    if (action === 'addProduct') {
      const id  = 'P' + Date.now();
      const buy = parseFloat(p.buyprice || p.buy) || 0;
      const doc = await Inventory.create({
        id,
        name:        p.name     || '',
        brand:       p.brand    || '',
        country:     p.country  || '',
        variant:     p.variant  || '',
        size:        p.size     || '',
        buyprice:    buy,
        sellprice:   parseFloat(p.sellprice || p.sell) || 0,
        qty:         parseInt(p.qty)   || 0,
        supplier:    p.supplier || '',
        lastbuydate: p.buydate  || new Date().toISOString().slice(0,10),
        lowestbuy:   parseFloat(p.lowestbuy) || buy,
        image:       p.image    || '',
        totalsold:   0,
        lastsolddate:'',
      });
      return res.json({ success: true, id });
    }

    if (action === 'updateProduct') {
      const update = {};
      if (p.name      !== undefined) update.name        = p.name;
      if (p.brand     !== undefined) update.brand       = p.brand;
      if (p.country   !== undefined) update.country     = p.country;
      if (p.variant   !== undefined) update.variant     = p.variant;
      if (p.size      !== undefined) update.size        = p.size;
      if (p.buyprice  !== undefined || p.buy  !== undefined)
        update.buyprice  = parseFloat(p.buyprice || p.buy) || 0;
      if (p.sellprice !== undefined || p.sell !== undefined)
        update.sellprice = parseFloat(p.sellprice || p.sell) || 0;
      if (p.qty       !== undefined) update.qty         = parseInt(p.qty) || 0;
      if (p.supplier  !== undefined) update.supplier    = p.supplier;
      if (p.buydate   !== undefined) update.lastbuydate = p.buydate;
      if (p.lowestbuy !== undefined) update.lowestbuy   = parseFloat(p.lowestbuy) || 0;
      if (p.image     !== undefined) update.image       = p.image;
      const doc = await Inventory.findOneAndUpdate({ id: p.id }, update, { new: true });
      if (!doc) return res.json({ error: 'Not found: ' + p.id });
      return res.json({ success: true });
    }

    if (action === 'deleteProduct') {
      await Inventory.deleteOne({ id: p.id });
      return res.json({ success: true });
    }

    if (action === 'restock') {
      const qty   = parseInt(p.qty)     || 0;
      const price = parseFloat(p.price) || 0;
      const prod  = await Inventory.findOne({ id: p.productId });
      if (!prod) return res.json({ error: 'Product not found: ' + p.productId });
      const newQty    = (prod.qty || 0) + qty;
      const curLowest = prod.lowestbuy || price;
      await Inventory.findOneAndUpdate({ id: p.productId }, {
        buyprice:    price,
        qty:         newQty,
        lastbuydate: p.date || new Date().toISOString().slice(0,10),
        lowestbuy:   Math.min(curLowest, price),
      });
      await Restock.create({
        id:            'RS' + Date.now(),
        productid:     p.productId   || '',
        productname:   p.productName || '',
        addedqty:      qty,
        purchaseprice: price,
        supplier:      p.supplier    || '',
        date:          p.date || new Date().toISOString().slice(0,10),
        note:          p.note || '',
      });
      return res.json({ success: true });
    }

    if (action === 'updateSold') {
      const qty  = parseInt(p.qty) || 1;
      const date = p.date || new Date().toISOString().slice(0,10);
      const prod = await Inventory.findOne({ id: p.id });
      if (!prod) return res.json({ error: 'Product not found' });
      await Inventory.findOneAndUpdate({ id: p.id }, {
        totalsold:    (prod.totalsold || 0) + qty,
        lastsolddate: date,
      });
      return res.json({ success: true });
    }

    // ── ORDERS ──

    if (action === 'addOrder') {
      const id = p.id || ('ORD-' + Date.now().toString().slice(-6));
      let items = p.items || [];
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch(e) { items = []; }
      }
      await Order.create({
        id,
        parcelid:     p.parcelId     || '',
        trackinglink: p.trackingLink || '',
        customer:     p.customer     || '',
        phone:        p.phone        || '',
        product:      p.product      || '',
        productid:    p.productId    || '',
        variant:      p.variant      || '',
        qty:          parseInt(p.qty)     || 1,
        total:        parseFloat(p.total) || 0,
        status:       p.status || 'pending',
        date:         p.date   || new Date().toISOString().slice(0,10),
        note:         p.note   || '',
        items,
        address:      p.address  || '',
        district:     p.district || '',
        thana:        p.thana    || '',
      });
      return res.json({ success: true, id });
    }

    if (action === 'updateOrder') {
      const update = {};
      if (p.parcelId     !== undefined) update.parcelid     = p.parcelId;
      if (p.trackingLink !== undefined) update.trackinglink = p.trackingLink;
      if (p.customer     !== undefined) update.customer     = p.customer;
      if (p.phone        !== undefined) update.phone        = p.phone;
      if (p.product      !== undefined) update.product      = p.product;
      if (p.productId    !== undefined) update.productid    = p.productId;
      if (p.variant      !== undefined) update.variant      = p.variant;
      if (p.qty          !== undefined) update.qty          = parseInt(p.qty) || 1;
      if (p.total        !== undefined) update.total        = parseFloat(p.total) || 0;
      if (p.status       !== undefined) update.status       = p.status;
      if (p.date         !== undefined) update.date         = p.date;
      if (p.note         !== undefined) update.note         = p.note;
      if (p.address      !== undefined) update.address      = p.address;
      if (p.district     !== undefined) update.district     = p.district;
      if (p.thana        !== undefined) update.thana        = p.thana;
      if (p.items        !== undefined) {
        let items = p.items;
        if (typeof items === 'string') { try { items = JSON.parse(items); } catch(e) { items = []; } }
        update.items = items;
      }
      const doc = await Order.findOneAndUpdate({ id: p.id }, update, { new: true });
      if (!doc) return res.json({ error: 'Not found: ' + p.id });
      return res.json({ success: true });
    }

    if (action === 'deleteOrder') {
      await Order.deleteOne({ id: p.id });
      return res.json({ success: true });
    }

    if (action === 'updateOrderStatus') {
      await Order.findOneAndUpdate({ id: p.id }, { status: p.status });
      return res.json({ success: true });
    }

    if (action === 'updateTracking') {
      const update = {};
      if (p.parcelId     !== undefined) update.parcelid     = p.parcelId;
      if (p.trackingLink !== undefined) update.trackinglink = p.trackingLink;
      if (p.status       !== undefined) update.status       = p.status;
      await Order.findOneAndUpdate({ id: p.id }, update);
      return res.json({ success: true });
    }

    // ── SUPPLIERS ──

    if (action === 'addSupplier') {
      const id = 'S' + Date.now();
      await Supplier.create({
        id,
        name:    p.name    || '',
        phone:   p.phone   || '',
        phone2:  p.phone2  || '',
        phone3:  p.phone3  || '',
        address: p.address || '',
      });
      return res.json({ success: true, id });
    }

    if (action === 'updateSupplier') {
      await Supplier.findOneAndUpdate({ id: p.id }, {
        name:    p.name    || '',
        phone:   p.phone   || '',
        phone2:  p.phone2  || '',
        phone3:  p.phone3  || '',
        address: p.address || '',
      });
      return res.json({ success: true });
    }

    if (action === 'deleteSupplier') {
      await Supplier.deleteOne({ id: p.id });
      return res.json({ success: true });
    }

    return res.json({ error: 'Unknown action: ' + action });

  } catch(e) {
    console.error('[stock write]', action, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════
// SHOP ROUTES (Public)
// ════════════════════════════════
app.get('/api/shop/products', async (req, res) => {
  try {
    const [inv, ords] = await Promise.all([
      Inventory.find({ qty: { $gt: 0 } }).sort({ createdAt: -1 }),
      Order.find().sort({ createdAt: -1 }),
    ]);
    const products = cleanAll(inv).map(p => ({
      id:        p.id,
      name:      p.name,
      brand:     p.brand   || '',
      variant:   p.variant || '',
      size:      p.size    || '',
      country:   p.country || '',
      image:     p.image   || '',
      sell:      p.sellprice || 0,
      sellprice: p.sellprice || 0,
      qty:       p.qty || 0,
      // buyprice intentionally excluded
    }));
    const orders = cleanAll(ords).map(o => ({
      id:           o.id,
      product:      o.product,
      customer:     o.customer,
      status:       o.status,
      date:         o.date,
      total:        o.total,
      parcelid:     o.parcelid     || '',
      trackinglink: o.trackinglink || '',
    }));
    res.json({ products, orders });
  } catch(e) {
    console.error('[shop products]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/shop/order', async (req, res) => {
  try {
    const p  = req.body;
    const id = p.id || ('ORD-' + Date.now().toString().slice(-6));
    await Order.create({
      id,
      customer: p.customer || '',
      phone:    p.phone    || '',
      product:  p.product  || '',
      productid:p.productId|| '',
      qty:      parseInt(p.qty)     || 1,
      total:    parseFloat(p.total) || 0,
      status:   'pending',
      date:     p.date || new Date().toISOString().slice(0,10),
      note:     p.note || '',
      address:  p.address || '',
      items:    [],
    });
    res.json({ success: true, id });
  } catch(e) {
    console.error('[shop order]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/shop/order', async (req, res) => {
  try {
    const p  = req.query;
    const id = p.id || ('ORD-' + Date.now().toString().slice(-6));
    await Order.create({
      id,
      customer: p.customer || '',
      phone:    p.phone    || '',
      product:  p.product  || '',
      qty:      parseInt(p.qty)     || 1,
      total:    parseFloat(p.total) || 0,
      status:   'pending',
      date:     p.date || new Date().toISOString().slice(0,10),
      note:     p.note || '',
      address:  p.address || '',
      items:    [],
    });
    res.json({ success: true, id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/shop/track', async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const order = await Order.findOne({
      $or: [
        { id:       { $regex: new RegExp('^'+orderId+'$','i') } },
        { parcelid: { $regex: new RegExp('^'+orderId+'$','i') } },
      ]
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const o = clean(order);
    res.json({
      id:           o.id,
      product:      o.product,
      customer:     o.customer,
      status:       o.status,
      date:         o.date,
      total:        o.total,
      parcelid:     o.parcelid     || '',
      trackinglink: o.trackinglink || '',
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════
// INBOX (এখনো Sheet based — optional)
// ════════════════════════════════
app.get('/api/inbox', adminOnly, async (req, res) => {
  if (!INBOX_SHEET_URL) return res.status(503).json({ error: 'INBOX_SHEET_URL not configured' });
  try {
    const params = new URLSearchParams(req.query);
    const d = await safeFetch(`${INBOX_SHEET_URL}?${params.toString()}`);
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/inbox/reply', adminOnly, async (req, res) => {
  if (!N8N_REPLY_URL) return res.status(503).json({ error: 'N8N_REPLY_URL not configured' });
  try {
    const r    = await fetch(N8N_REPLY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(req.body),
    });
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch(e) { d = { success: true }; }
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════
// PUBLIC CONFIG
// ════════════════════════════════
app.get('/api/config', (req, res) => {
  res.json({
    whatsapp: WHATSAPP_NUMBER,
    hasStock: true,
    hasShop:  true,
    hasInbox: !!INBOX_SHEET_URL,
  });
});

app.get('/health', async (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = ['disconnected','connected','connecting','disconnecting'][dbState] || 'unknown';
  res.json({
    ok:       dbState === 1,
    db:       dbStatus,
    ts:       Date.now(),
    hasInbox: !!INBOX_SHEET_URL,
    hasN8n:   !!N8N_REPLY_URL,
  });
});

// Cache clear (now just a no-op since we use MongoDB)
app.post('/api/cache/clear', adminOnly, (req, res) => {
  res.json({ ok: true, message: 'No cache to clear (MongoDB mode)' });
});

// ════════════════════════════════
// HTML ROUTES
// ════════════════════════════════
app.get('/admin',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));

app.use((err, req, res, next) => {
  console.error('[server error]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`✅ Minsah running on port ${PORT} (MongoDB mode)`);
  console.log(`   Inbox:  ${INBOX_SHEET_URL ? '✅' : '❌ not configured'}`);
  console.log(`   n8n:    ${N8N_REPLY_URL   ? '✅' : '❌ not configured'}`);
});
