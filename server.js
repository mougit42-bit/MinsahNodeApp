const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const mongoose = require('mongoose');
const Minio    = require('minio');
const sharp    = require('sharp');
const multer   = require('multer');

// Multer — memory storage (file disk এ যাবে না)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

const app  = express();
const PORT = process.env.PORT || 4000;

// ── SSE clients store (real-time push)
const sseClients = new Set();

function pushToClients(event, data) {
  const payload = `event: ${event}
data: ${JSON.stringify(data)}

`;
  for (const client of sseClients) {
    try { client.write(payload); } catch(e) { sseClients.delete(client); }
  }
}

// ════════════════════════════════
// ENV VARIABLES
// ════════════════════════════════
const MONGODB_URL          = process.env.MONGODB_URL          || '';
const N8N_REPLY_URL        = process.env.N8N_REPLY_URL        || '';
const WHATSAPP_NUMBER      = process.env.WHATSAPP_NUMBER      || '';
const META_VERIFY_TOKEN    = process.env.META_VERIFY_TOKEN    || '';
const META_GRAPH_API_TOKEN = process.env.META_GRAPH_API_TOKEN || '';

// ২টা Page এর tokens
const PAGE_TOKENS = {
  '1060414697146343': process.env.PAGE_TOKEN_1060414697146343 || '',
  '1045182078668089': process.env.PAGE_TOKEN_1045182078668089 || '',
};

// MinIO config
const MINIO_ENDPOINT   = process.env.MINIO_ENDPOINT   || '';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || '';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || '';
const MINIO_BUCKET     = process.env.MINIO_BUCKET     || 'minsah-inbox';
const MINIO_USE_SSL    = process.env.MINIO_USE_SSL !== 'false';
const MINIO_PORT       = parseInt(process.env.MINIO_PORT) || (MINIO_USE_SSL ? 443 : 9000);
// Public URL for browser access (different from internal endpoint)
const STORAGE_PUBLIC_URL = process.env.STORAGE_PUBLIC_URL || '';

// MinIO client
let minioClient = null;
if (MINIO_ENDPOINT && MINIO_ACCESS_KEY && MINIO_SECRET_KEY) {
  minioClient = new Minio.Client({
    endPoint:  MINIO_ENDPOINT,
    port:      MINIO_PORT,
    useSSL:    MINIO_USE_SSL,
    accessKey: MINIO_ACCESS_KEY,
    secretKey: MINIO_SECRET_KEY,
  });
  minioClient.bucketExists(MINIO_BUCKET, (err, exists) => {
    if (err) { console.error('[MinIO] bucket check error:', err.message); return; }
    if (!exists) {
      minioClient.makeBucket(MINIO_BUCKET, 'ap-south-1', (err) => {
        if (err) console.error('[MinIO] bucket create error:', err.message);
        else {
          console.log(`✅ MinIO bucket '${MINIO_BUCKET}' created`);
          const policy = JSON.stringify({
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${MINIO_BUCKET}/*`] }]
          });
          minioClient.setBucketPolicy(MINIO_BUCKET, policy, () => {});
        }
      });
    } else {
      console.log(`✅ MinIO connected — bucket: ${MINIO_BUCKET}`);
    }
  });
}

// ── MinIO তে file save করো
async function saveToMinio(metaUrl, pageToken, fileType = 'file') {
  if (!minioClient) return metaUrl;
  try {
    const r = await fetch(metaUrl, { headers: pageToken ? { 'Authorization': `Bearer ${pageToken}` } : {} });
    if (!r.ok) throw new Error('Download failed: ' + r.status);
    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await r.arrayBuffer());
    const extMap = {
      'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
      'audio/wav': '.wav', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    };
    const ext = extMap[contentType] || ('.' + (contentType.split('/')[1] || 'bin'));
    const filename = `${fileType}/${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    await minioClient.putObject(MINIO_BUCKET, filename, buffer, buffer.length, { 'Content-Type': contentType });
    const protocol = MINIO_USE_SSL ? 'https' : 'http';
    const portSuffix = MINIO_USE_SSL ? '' : `:${MINIO_PORT}`;
    return `${protocol}://${MINIO_ENDPOINT}${portSuffix}/${MINIO_BUCKET}/${filename}`;
  } catch(e) {
    console.error('[MinIO save error]', e.message);
    return metaUrl;
  }
}

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
  id:           { type: String, required: true, unique: true },
  name:         { type: String, default: '' },
  brand:        { type: String, default: '' },
  country:      { type: String, default: '' },
  variant:      { type: String, default: '' },
  size:         { type: String, default: '' },
  buyprice:     { type: Number, default: 0 },
  sellprice:    { type: Number, default: 0 },
  qty:          { type: Number, default: 0 },
  supplier:     { type: String, default: '' },
  lastbuydate:  { type: String, default: '' },
  lowestbuy:    { type: Number, default: 0 },
  image:        { type: String, default: '' },
  totalsold:    { type: Number, default: 0 },
  lastsolddate: { type: String, default: '' },
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

// ✅ Message Schema — image, comment support সহ
const messageSchema = new mongoose.Schema({
  id:          { type: String, required: true, unique: true },
  senderid:    { type: String, default: '' },
  sendername:  { type: String, default: '' },
  senderavatar:{ type: String, default: '' },  // profile picture URL
  platform:    { type: String, default: 'fb' }, // 'fb' | 'ig'
  pageid:      { type: String, default: '' },
  message:     { type: String, default: '' },
  imageurl:    { type: String, default: '' },   // customer পাঠানো image
  direction:   { type: String, default: 'in' }, // 'in' | 'out'
  type:        { type: String, default: 'message' }, // 'message' | 'comment'
  commentid:   { type: String, default: '' },   // Facebook comment ID (reply করতে লাগবে)
  postid:      { type: String, default: '' },   // কোন post এর comment
  timestamp:   { type: String, default: '' },
  read:        { type: String, default: 'false' },
  convid:      { type: String, default: '' },
  mediatype:   { type: String, default: 'message' }, // message|image|audio|video|file|location
}, { timestamps: true });

// ✅ Customer CRM schema
const customerSchema = new mongoose.Schema({
  fbid:        { type: String, required: true, unique: true }, // Facebook/Instagram sender ID
  name:        { type: String, default: '' },
  customname:  { type: String, default: '' }, // admin যে নাম দেবে
  phone:       { type: String, default: '' },
  address:     { type: String, default: '' },
  district:    { type: String, default: '' },
  thana:       { type: String, default: '' },
  note:        { type: String, default: '' },
  platform:    { type: String, default: 'fb' },
  // Auto-calculated
  totalorders: { type: Number, default: 0 },
  totalspent:  { type: Number, default: 0 },
  // tier: auto — 0 order=new, 1-2=bronze, 3-5=silver, 6+=gold
  tier:        { type: String, default: 'new' }, // 'new'|'bronze'|'silver'|'gold'
  lastorderat: { type: String, default: '' },
}, { timestamps: true });

const Inventory = mongoose.model('Inventory', inventorySchema);
const Order     = mongoose.model('Order',     orderSchema);
const Supplier  = mongoose.model('Supplier',  supplierSchema);
const Restock   = mongoose.model('Restock',   restockSchema);
const Message   = mongoose.model('Message',   messageSchema);
const Customer  = mongoose.model('Customer',  customerSchema);

// ── Tier calculate helper ──
function calcTier(totalorders) {
  if (totalorders === 0) return 'new';
  if (totalorders <= 2)  return 'bronze';
  if (totalorders <= 5)  return 'silver';
  return 'gold';
}

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

// ── doc → plain object ──
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

// ── Page token খোঁজো ──
function getPageToken(pageId) {
  return PAGE_TOKENS[pageId] || META_GRAPH_API_TOKEN || '';
}

// ── Meta Graph API helper ──
async function metaPost(url, body, token) {
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ...body, access_token: token }),
  });
  return r.json();
}

// ── Sender name + avatar fetch ──
async function fetchSenderProfile(senderId, token) {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${senderId}?fields=name,profile_pic&access_token=${token}`
    );
    const d = await r.json();
    return { name: d.name || senderId, avatar: d.profile_pic || '' };
  } catch(e) {
    return { name: senderId, avatar: '' };
  }
}

// ════════════════════════════════
// META WEBHOOK ROUTES
// ════════════════════════════════

// ── GET: Webhook Verification (Meta developer console থেকে)
app.get('/webhook/meta', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    res.status(200).send(challenge);
  } else {
    console.warn('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// ── POST: Webhook Receiver — Message + Comment + Image
app.post('/webhook/meta', async (req, res) => {
  res.sendStatus(200); // Meta কে আগেই 200 দাও — timeout এড়াতে

  try {
    const body = req.body;
    if (!body || !body.entry) return;

    for (const entry of body.entry) {
      const pageId = entry.id;
      const token  = getPageToken(pageId);

      // ── ১. MESSAGES (Messenger + Instagram DM)
      for (const event of entry.messaging || []) {
        if (!event.message) continue;
        if (event.message.is_echo) continue; // নিজের sent message skip

        const senderId = event.sender.id;
        const msgText  = event.message.text || '';
        const platform = body.object === 'instagram' ? 'ig' : 'fb';

        // Image / attachment check — MinIO তে save করো
        let imageUrl   = '';
        let mediaType  = 'message'; // message | image | audio | video
        let displayMsg = msgText;
        const attachments = event.message.attachments || [];
        for (const att of attachments) {
          const rawUrl = att.payload?.url || att.file_url || '';
          if (att.type === 'image') {
            imageUrl   = rawUrl ? await saveToMinio(rawUrl, token, 'images') : '';
            displayMsg = displayMsg || '📷 Image';
            mediaType  = 'image';
          } else if (att.type === 'audio') {
            imageUrl   = rawUrl ? await saveToMinio(rawUrl, token, 'audio') : '';
            displayMsg = displayMsg || '🎵 Voice Message';
            mediaType  = 'audio';
          } else if (att.type === 'video') {
            imageUrl   = rawUrl ? await saveToMinio(rawUrl, token, 'video') : '';
            displayMsg = displayMsg || '🎥 Video';
            mediaType  = 'video';
          } else if (att.type === 'file') {
            imageUrl   = rawUrl ? await saveToMinio(rawUrl, token, 'files') : '';
            displayMsg = displayMsg || '📎 File';
            mediaType  = 'file';
          } else if (att.type === 'sticker') {
            imageUrl   = rawUrl ? await saveToMinio(rawUrl, token, 'stickers') : '';
            displayMsg = displayMsg || '🔖 Sticker';
            mediaType  = 'image';
          } else if (att.type === 'location') {
            displayMsg = displayMsg || `📍 Location: ${att.payload?.lat||''},${att.payload?.long||''}`;
            mediaType  = 'location';
          }
        }

        // Profile fetch
        const profile = await fetchSenderProfile(senderId, token);

        await Message.create({
          id:           Date.now() + Math.random().toString(36).slice(2),
          senderid:     senderId,
          sendername:   profile.name,
          senderavatar: profile.avatar,
          platform,
          pageid:       pageId,
          message:      displayMsg,
          imageurl:     imageUrl,
          mediatype:    mediaType,
          direction:    'in',
          type:         'message',
          timestamp:    new Date().toISOString(),
          read:         'false',
          convid:       senderId,
        });

        console.log(`[webhook] 💬 Message from ${profile.name} (${platform}): ${displayMsg}`);

        // ── Real-time push to admin panel
        pushToClients('new_message', {
          senderid:    senderId,
          sendername:  profile.name,
          senderavatar:profile.avatar,
          platform,
          pageid:      pageId,
          message:     displayMsg,
          imageurl:    imageUrl,
          mediatype:   mediaType,
          direction:   'in',
          type:        'message',
          timestamp:   new Date().toISOString(),
          read:        'false',
          convid:      senderId,
        });
      }

      // ── ২. COMMENTS (Facebook Page posts)
      for (const change of entry.changes || []) {
        if (change.field !== 'feed') continue;
        const val = change.value;

        // নতুন comment
        if (val.item === 'comment' && val.verb === 'add') {
          const commentId = val.comment_id || '';
          const postId    = val.post_id    || '';
          const from      = val.from       || {};
          const commentMsg= val.message    || '';

          // নিজের page এর comment skip
          if (from.id === pageId) continue;

          await Message.create({
            id:          Date.now() + Math.random().toString(36).slice(2),
            senderid:    from.id    || '',
            sendername:  from.name  || from.id || 'Unknown',
            platform:    'fb',
            pageid:      pageId,
            message:     commentMsg,
            imageurl:    '',
            direction:   'in',
            type:        'comment',
            commentid:   commentId,
            postid:      postId,
            timestamp:   new Date().toISOString(),
            read:        'false',
            convid:      from.id || commentId,
          });

          console.log(`[webhook] 💬 Comment from ${from.name}: ${commentMsg}`);

          // ── Real-time push
          pushToClients('new_message', {
            senderid:   from.id || '',
            sendername: from.name || 'Unknown',
            platform:   'fb',
            pageid:     pageId,
            message:    commentMsg,
            direction:  'in',
            type:       'comment',
            commentid:  commentId,
            postid:     postId,
            timestamp:  new Date().toISOString(),
            read:       'false',
            convid:     from.id || commentId,
          });
        }
      }
    }
  } catch(e) {
    console.error('[webhook meta error]', e.message);
  }
});

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
  const p      = req.body;
  const action = p.action || '';

  try {
    // ── INVENTORY ──
    if (action === 'addProduct') {
      const id  = 'P' + Date.now();
      const buy = parseFloat(p.buyprice || p.buy) || 0;
      await Inventory.create({
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
    const inv = await Inventory.find({ qty: { $gt: 0 } }).sort({ createdAt: -1 });
    const products = cleanAll(inv).map(p => ({
      id:        p.id,
      name:      p.name,
      brand:     p.brand    || '',
      variant:   p.variant  || '',
      size:      p.size     || '',
      country:   p.country  || '',
      image:     p.image    || '',
      sell:      p.sellprice || 0,
      sellprice: p.sellprice || 0,
      qty:       p.qty || 0,
    }));
    res.json({ products });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/shop/order', async (req, res) => {
  try {
    const p  = req.body;
    const id = p.id || ('ORD-' + Date.now().toString().slice(-6));
    await Order.create({
      id,
      customer:  p.customer  || '',
      phone:     p.phone     || '',
      product:   p.product   || '',
      productid: p.productId || '',
      qty:       parseInt(p.qty)     || 1,
      total:     parseFloat(p.total) || 0,
      status:    'pending',
      date:      p.date || new Date().toISOString().slice(0,10),
      note:      p.note    || '',
      address:   p.address || '',
      items:     [],
    });
    res.json({ success: true, id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/shop/order', async (req, res) => {
  try {
    const p  = req.query;
    const id = p.id || ('ORD-' + Date.now().toString().slice(-6));
    await Order.create({
      id,
      customer:  p.customer  || '',
      phone:     p.phone     || '',
      product:   p.product   || '',
      qty:       parseInt(p.qty)     || 1,
      total:     parseFloat(p.total) || 0,
      status:    'pending',
      date:      p.date || new Date().toISOString().slice(0,10),
      note:      p.note    || '',
      address:   p.address || '',
      items:     [],
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
// INBOX ROUTES — MongoDB
// ════════════════════════════════

// ── n8n থেকে message save (public endpoint)
app.post('/api/inbox/save', async (req, res) => {
  try {
    const p = req.body;
    await Message.create({
      id:          Date.now() + Math.random().toString(36).slice(2),
      senderid:    p.senderId    || '',
      sendername:  p.senderName  || p.senderId || '',
      senderavatar:p.senderAvatar|| '',
      platform:    p.platform    || 'fb',
      pageid:      p.pageId      || '',
      message:     p.message     || '',
      imageurl:    p.imageUrl    || '',
      direction:   p.direction   || 'in',
      type:        p.type        || 'message',
      commentid:   p.commentId   || '',
      postid:      p.postId      || '',
      timestamp:   p.timestamp   || new Date().toISOString(),
      read:        p.direction === 'out' ? 'true' : 'false',
      convid:      p.convId      || p.senderId || '',
    });
    res.json({ success: true });
  } catch(e) {
    console.error('[inbox save]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin panel থেকে messages পড়া + markRead
app.get('/api/inbox', adminOnly, async (req, res) => {
  const action = req.query.action || '';
  try {
    if (action === 'getMessages') {
      const msgs = await Message.find().sort({ timestamp: -1 }).limit(500);
      return res.json({ messages: cleanAll(msgs) });
    }
    if (action === 'markRead') {
      const convId = req.query.convId || '';
      await Message.updateMany({ convid: convId }, { read: 'true' });
      return res.json({ success: true });
    }
    res.json({ error: 'Unknown action' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin থেকে Messenger/Instagram DM reply (text + image)
app.post('/api/inbox/reply', adminOnly, async (req, res) => {
  const { recipientId, message, imageUrl, pageId } = req.body;
  if (!recipientId) return res.status(400).json({ error: 'recipientId required' });

  const token = getPageToken(pageId);
  if (!token) return res.status(400).json({ error: 'Page token not found for pageId: ' + pageId });

  try {
    // Text message পাঠাও
    if (message) {
      const r = await metaPost(
        'https://graph.facebook.com/v19.0/me/messages',
        { recipient: { id: recipientId }, message: { text: message } },
        token
      );
      if (r.error) return res.status(400).json({ error: r.error.message });
    }

    // Image পাঠাও
    if (imageUrl) {
      await metaPost(
        'https://graph.facebook.com/v19.0/me/messages',
        {
          recipient: { id: recipientId },
          message:   { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } },
        },
        token
      );
    }

    // Outgoing message MongoDB তে save করো
    await Message.create({
      id:        Date.now() + Math.random().toString(36).slice(2),
      senderid:  recipientId,
      direction: 'out',
      type:      'message',
      message:   message || (imageUrl ? '📷 Image sent' : ''),
      imageurl:  imageUrl || '',
      platform:  'fb',
      pageid:    pageId || '',
      timestamp: new Date().toISOString(),
      read:      'true',
      convid:    recipientId,
    });

    res.json({ success: true });
  } catch(e) {
    console.error('[inbox reply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin থেকে Facebook Comment reply
app.post('/api/inbox/comment-reply', adminOnly, async (req, res) => {
  const { commentId, message, pageId, senderId } = req.body;
  if (!commentId || !message) return res.status(400).json({ error: 'commentId and message required' });

  const token = getPageToken(pageId);
  if (!token) return res.status(400).json({ error: 'Page token not found for pageId: ' + pageId });

  try {
    // Facebook comment এ reply
    const r = await metaPost(
      `https://graph.facebook.com/v19.0/${commentId}/comments`,
      { message },
      token
    );
    if (r.error) return res.status(400).json({ error: r.error.message });

    // Outgoing comment MongoDB তে save
    await Message.create({
      id:        Date.now() + Math.random().toString(36).slice(2),
      senderid:  senderId  || commentId,
      direction: 'out',
      type:      'comment',
      message:   message,
      commentid: commentId,
      platform:  'fb',
      pageid:    pageId || '',
      timestamp: new Date().toISOString(),
      read:      'true',
      convid:    senderId || commentId,
    });

    res.json({ success: true, commentReplyId: r.id });
  } catch(e) {
    console.error('[comment reply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════
// META HISTORY SYNC
// ════════════════════════════════

// ── পুরনো conversations bulk sync (admin এ একবার চালাবে)
app.post('/api/inbox/sync-history', adminOnly, async (req, res) => {
  const { pageId } = req.body;
  const token = getPageToken(pageId);
  if (!token) return res.status(400).json({ error: 'No page token for pageId: ' + pageId });

  let totalSaved = 0;
  let totalSkipped = 0;
  let errors = [];

  // Progress push helper
  function pushProgress(msg, pct) {
    pushToClients('sync_progress', { msg, pct, saved: totalSaved, skipped: totalSkipped });
    console.log(`[sync] ${pct}% — ${msg}`);
  }

  try {
    pushProgress('Conversations আনছি...', 0);

    // ── Step 1: সব conversations আনো (paginated)
    let convUrl = `https://graph.facebook.com/v19.0/me/conversations?fields=id,participants&limit=100&access_token=${token}`;
    let allConvIds = [];

    while (convUrl) {
      const r = await fetch(convUrl);
      const d = await r.json();
      if (d.error) { errors.push(d.error.message); break; }
      for (const conv of d.data || []) allConvIds.push(conv.id);
      convUrl = d.paging?.next || null;
      if (allConvIds.length > 500) break; // safety limit
    }

    console.log(`[sync] Found ${allConvIds.length} conversations`);
    pushProgress(`${allConvIds.length}টি conversation পেয়েছি`, 5);

    // ── Step 2: প্রতিটা conversation এর messages আনো
    for (const [idx, convId] of allConvIds.entries()) {
      const pct = Math.round(5 + (idx / allConvIds.length) * 90);
      if (idx % 5 === 0) pushProgress(`Processing ${idx+1}/${allConvIds.length} conversations... (saved: ${totalSaved})`, pct);
      try {
        let msgUrl = `https://graph.facebook.com/v19.0/${convId}/messages?fields=id,message,from,created_time,attachments&limit=100&access_token=${token}`;

        while (msgUrl) {
          const r  = await fetch(msgUrl);
          const d  = await r.json();
          if (d.error) { errors.push(d.error.message); break; }

          for (const msg of d.data || []) {
            try {
              // Duplicate check
              const exists = await Message.findOne({ id: msg.id });
              if (exists) { totalSkipped++; continue; }

              const isOut     = msg.from?.id === pageId;
              const senderId  = isOut ? pageId : (msg.from?.id || '');
              const senderName= isOut ? 'Minsah' : (msg.from?.name || '');

              // Attachment check + RustFS এ save
              let imageUrl  = '';
              let mediaType = 'message';
              let msgText   = msg.message || '';

              for (const att of msg.attachments?.data || []) {
                const rawUrl = att.image_data?.url || att.file_url || att.payload?.url || '';

                if (att.image_data?.url || att.mime_type?.startsWith('image')) {
                  // Image → RustFS
                  imageUrl  = rawUrl ? await saveToMinio(rawUrl, token, 'images') : '';
                  msgText   = msgText || '📷 Image';
                  mediaType = 'image';
                } else if (att.mime_type?.startsWith('audio')) {
                  // Audio/Voice → RustFS
                  imageUrl  = rawUrl ? await saveToMinio(rawUrl, token, 'audio') : '';
                  msgText   = msgText || '🎵 Voice Message';
                  mediaType = 'audio';
                } else if (att.mime_type?.startsWith('video')) {
                  // Video → RustFS
                  imageUrl  = rawUrl ? await saveToMinio(rawUrl, token, 'video') : '';
                  msgText   = msgText || '🎥 Video';
                  mediaType = 'video';
                } else if (att.mime_type) {
                  // Other file → RustFS
                  imageUrl  = rawUrl ? await saveToMinio(rawUrl, token, 'files') : '';
                  msgText   = msgText || '📎 File';
                  mediaType = 'file';
                }
              }

              await Message.create({
                id:          msg.id,
                senderid:    senderId,
                sendername:  senderName,
                platform:    'fb',
                pageid:      pageId,
                message:     msgText,
                imageurl:    imageUrl,
                mediatype:   mediaType,
                direction:   isOut ? 'out' : 'in',
                type:        'message',
                timestamp:   msg.created_time || new Date().toISOString(),
                read:        'true',
                convid:      senderId,
              });
              totalSaved++;
            } catch(e) {
              if (!e.message.includes('duplicate')) errors.push(e.message);
            }
          }

          msgUrl = d.paging?.next || null;
        }
      } catch(e) {
        errors.push('Conv ' + convId + ': ' + e.message);
      }
    }

    console.log(`[sync] Saved: ${totalSaved}, Skipped: ${totalSkipped}`);
    pushProgress(`✅ Sync complete! ${totalSaved} saved, ${totalSkipped} skipped`, 100);
    res.json({ success: true, saved: totalSaved, skipped: totalSkipped, convs: allConvIds.length, errors: errors.slice(0, 5) });

  } catch(e) {
    console.error('[sync history]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── দুটো page এর history একসাথে sync
app.post('/api/inbox/sync-all', adminOnly, async (req, res) => {
  const results = [];
  for (const pageId of Object.keys(PAGE_TOKENS)) {
    if (!PAGE_TOKENS[pageId]) continue;
    try {
      const r = await fetch(`http://localhost:${PORT}/api/inbox/sync-history`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': process.env.ADMIN_PASSWORD },
        body:    JSON.stringify({ pageId }),
      });
      const d = await r.json();
      results.push({ pageId, ...d });
    } catch(e) {
      results.push({ pageId, error: e.message });
    }
  }
  res.json({ results });
});

// ════════════════════════════════
// CUSTOMER CRM ROUTES
// ════════════════════════════════

// ── Facebook ID দিয়ে customer খোঁজো (inbox থেকে call হবে)
app.get('/api/customers/:fbid', adminOnly, async (req, res) => {
  try {
    const fbid = req.params.fbid;
    let customer = await Customer.findOne({ fbid });

    if (!customer) {
      // নতুন customer — orders থেকে data খোঁজার চেষ্টা করো
      return res.json({ found: false, customer: null });
    }

    // Orders থেকে latest stats calculate করো
    const custOrders = await Order.find({
      $or: [
        { customer: { $regex: new RegExp(customer.customname || customer.name, 'i') } },
        { phone: customer.phone }
      ]
    }).sort({ createdAt: -1 });

    const totalorders = custOrders.length;
    const totalspent  = custOrders.reduce((s, o) => s + (o.total || 0), 0);
    const tier        = calcTier(totalorders);
    const lastorderat = custOrders[0]?.date || '';

    // Update stats
    await Customer.findOneAndUpdate({ fbid }, { totalorders, totalspent, tier, lastorderat });

    res.json({
      found: true,
      customer: {
        ...clean(customer),
        totalorders,
        totalspent,
        tier,
        lastorderat,
        recentOrders: custOrders.slice(0, 5).map(o => ({
          id:      o.id,
          product: o.product,
          total:   o.total,
          status:  o.status,
          date:    o.date,
        })),
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Customer save/update (admin inbox profile card থেকে)
app.post('/api/customers/save', adminOnly, async (req, res) => {
  try {
    const p = req.body;
    if (!p.fbid) return res.status(400).json({ error: 'fbid required' });

    const existing = await Customer.findOne({ fbid: p.fbid });
    const totalorders = existing?.totalorders || 0;
    const tier        = calcTier(totalorders);

    const data = {
      fbid:       p.fbid,
      name:       p.name       || existing?.name || '',
      customname: p.customname || existing?.customname || '',
      phone:      p.phone      || existing?.phone || '',
      address:    p.address    || existing?.address || '',
      district:   p.district   || existing?.district || '',
      thana:      p.thana      || existing?.thana || '',
      note:       p.note       || existing?.note || '',
      platform:   p.platform   || existing?.platform || 'fb',
      tier,
    };

    await Customer.findOneAndUpdate({ fbid: p.fbid }, data, { upsert: true, new: true });
    res.json({ success: true, tier });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── সব customers list
app.get('/api/customers', adminOnly, async (req, res) => {
  try {
    const customers = await Customer.find().sort({ createdAt: -1 });
    res.json({ customers: cleanAll(customers) });
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
    hasInbox: true,
  });
});

app.get('/health', async (req, res) => {
  const dbState  = mongoose.connection.readyState;
  const dbStatus = ['disconnected','connected','connecting','disconnecting'][dbState] || 'unknown';

  // RustFS/MinIO check
  let storageOk = false;
  let storageMsg = 'not configured';
  if (minioClient) {
    try {
      await minioClient.bucketExists(MINIO_BUCKET);
      storageOk  = true;
      storageMsg = `connected — bucket: ${MINIO_BUCKET}`;
    } catch(e) {
      storageMsg = e.message;
    }
  }

  res.json({
    ok:          dbState === 1,
    db:          dbStatus,
    ts:          Date.now(),
    webhook:     !!META_VERIFY_TOKEN,
    pageTokens:  Object.keys(PAGE_TOKENS).filter(k => !!PAGE_TOKENS[k]),
    storage:     { ok: storageOk, msg: storageMsg },
    sseClients:  sseClients.size,
  });
});

app.post('/api/cache/clear', adminOnly, (req, res) => {
  res.json({ ok: true, message: 'No cache (MongoDB mode)' });
});

// ════════════════════════════════
// IMAGE UPLOAD — RustFS + Sharp
// ════════════════════════════════

// ── Image optimize + RustFS তে save helper
async function processAndSaveImage(buffer, originalMime, folder = 'products') {
  if (!minioClient) throw new Error('Storage not configured');

  // Sharp দিয়ে optimize করো
  let processed;
  let finalMime = 'image/webp';
  let ext       = '.webp';

  try {
    const img = sharp(buffer);
    const meta = await img.metadata();

    // Resize — max 1200px wide, proportional height
    processed = await img
      .resize({
        width:  1200,
        height: 1200,
        fit:    'inside',         // aspect ratio maintain করো
        withoutEnlargement: true  // ছোট image বড় করবে না
      })
      .webp({ quality: 82 })     // WebP format, 82% quality
      .toBuffer();

    console.log(`[image] ${meta.width}x${meta.height} → optimized WebP (${Math.round(processed.length/1024)}KB)`);
  } catch(e) {
    console.warn('[image] Sharp failed, using original:', e.message);
    processed  = buffer;
    finalMime  = originalMime;
    ext        = '.' + (originalMime.split('/')[1] || 'jpg');
  }

  // RustFS তে upload
  const filename = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
  await minioClient.putObject(MINIO_BUCKET, filename, processed, processed.length, {
    'Content-Type': finalMime,
  });

  // Public URL বানাও
  if (STORAGE_PUBLIC_URL) {
    return `${STORAGE_PUBLIC_URL}/${MINIO_BUCKET}/${filename}`;
  }
  const protocol   = MINIO_USE_SSL ? 'https' : 'http';
  const portSuffix = MINIO_USE_SSL ? '' : `:${MINIO_PORT}`;
  return `${protocol}://${MINIO_ENDPOINT}${portSuffix}/${MINIO_BUCKET}/${filename}`;
}

// ── POST /api/upload — admin panel থেকে image upload
app.post('/api/upload', adminOnly, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const folder = req.body.folder || 'products'; // products | covers | etc
    const url    = await processAndSaveImage(req.file.buffer, req.file.mimetype, folder);

    res.json({ success: true, url });
  } catch(e) {
    console.error('[upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/upload/test — storage test
app.get('/api/upload/test', adminOnly, async (req, res) => {
  if (!minioClient) return res.json({ ok: false, msg: 'Storage not configured' });
  try {
    const exists = await minioClient.bucketExists(MINIO_BUCKET);
    res.json({ ok: true, bucket: MINIO_BUCKET, exists });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ════════════════════════════════
// SSE — Real-time push to admin
// ════════════════════════════════
app.get('/api/inbox/stream', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (!token || token !== ADMIN_PASSWORD) return res.status(401).end();
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx buffering বন্ধ
  res.flushHeaders();

  // Connected
  res.write(`event: connected
data: {"ok":true}

`);

  // Heartbeat every 25s — connection alive রাখো
  const heartbeat = setInterval(() => {
    try { res.write(`:heartbeat

`); } catch(e) { cleanup(); }
  }, 25000);

  sseClients.add(res);

  function cleanup() {
    clearInterval(heartbeat);
    sseClients.delete(res);
  }

  req.on('close',   cleanup);
  req.on('error',   cleanup);
  res.on('error',   cleanup);
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
  console.log(`   Webhook: ${META_VERIFY_TOKEN ? '✅ /webhook/meta' : '❌ META_VERIFY_TOKEN not set'}`);
  console.log(`   Pages:   ${Object.keys(PAGE_TOKENS).filter(k => PAGE_TOKENS[k]).join(', ') || '❌ none'}`);
});
