// ============================================================
// MINSAH BEAUTY — FIXED Google Apps Script v2
// Sheet tabs: Inventory, Orders, Suppliers, Restock
// ============================================================

const SHEETS = {
  INV:     'Inventory',
  ORD:     'Orders',
  SUP:     'Suppliers',
  RESTOCK: 'Restock'
};

// Column index reference (0-based):
// Inventory: 0=ID, 1=Name, 2=Brand, 3=Country, 4=Variant, 5=Size,
//            6=BuyPrice, 7=SellPrice, 8=Qty, 9=Supplier,
//            10=LastBuyDate, 11=LowestBuy, 12=Image,
//            13=TotalSold, 14=LastSoldDate
//
// Orders:    0=ID, 1=ParcelID, 2=TrackingLink, 3=Customer, 4=Phone,
//            5=Product, 6=ProductID, 7=Variant, 8=Qty, 9=Total,
//            10=Status, 11=Date, 12=Note, 13=Items(JSON)

function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function getOrCreate(ss, name, headers) {
  let s = ss.getSheetByName(name);
  if (!s) { s = ss.insertSheet(name); s.appendRow(headers); }
  return s;
}

function out(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const invS = getOrCreate(ss, SHEETS.INV, [
    'ID','Name','Brand','Country','Variant','Size',
    'BuyPrice','SellPrice','Qty','Supplier',
    'LastBuyDate','LowestBuy','Image','TotalSold','LastSoldDate'
  ]);
  const ordS = getOrCreate(ss, SHEETS.ORD, [
    'ID','ParcelID','TrackingLink','Customer','Phone',
    'Product','ProductID','Variant','Qty','Total',
    'Status','Date','Note','Items'
  ]);
  const supS = getOrCreate(ss, SHEETS.SUP, [
    'ID','Name','Phone','Phone2','Phone3','Address'
  ]);
  const rsS = getOrCreate(ss, SHEETS.RESTOCK, [
    'ID','ProductID','ProductName','AddedQty',
    'PurchasePrice','Supplier','Date','Note'
  ]);

  // GET params + POST body দুটোই support
  let p = e.parameter ? Object.assign({}, e.parameter) : {};
  if (e.postData && e.postData.contents) {
    try {
      const body = JSON.parse(e.postData.contents);
      p = Object.assign({}, p, body);
    } catch(err) {}
  }

  const action = p.action || '';

  // ── READ ──
  if (action === 'getAll') {
    return out({
      inventory: getData(invS),
      orders:    getOrderData(ordS),
      suppliers: getData(supS),
      restocks:  getData(rsS)
    });
  }

  // ── INVENTORY ──

  if (action === 'addProduct') {
    const id = 'P' + Date.now();
    const buy = parseFloat(p.buyprice || p.buy) || 0;
    invS.appendRow([
      id,
      p.name     || '',
      p.brand    || '',
      p.country  || '',
      p.variant  || '',
      p.size     || '',
      buy,                                              // col 6 BuyPrice
      parseFloat(p.sellprice || p.sell) || 0,          // col 7 SellPrice
      parseInt(p.qty) || 0,                            // col 8 Qty
      p.supplier || '',                                // col 9 Supplier
      p.buydate  || new Date().toISOString().slice(0,10), // col 10 LastBuyDate
      parseFloat(p.lowestbuy) || buy,                  // col 11 LowestBuy
      p.image    || '',                                // col 12 Image
      0,                                               // col 13 TotalSold
      ''                                               // col 14 LastSoldDate
    ]);
    return out({ success: true, id });
  }

  if (action === 'updateProduct') {
    const fields = {};
    if (p.name     !== undefined) fields[1]  = p.name;
    if (p.brand    !== undefined) fields[2]  = p.brand;
    if (p.country  !== undefined) fields[3]  = p.country;
    if (p.variant  !== undefined) fields[4]  = p.variant;
    if (p.size     !== undefined) fields[5]  = p.size;
    if (p.buyprice !== undefined || p.buy  !== undefined)
      fields[6] = parseFloat(p.buyprice || p.buy) || 0;
    if (p.sellprice !== undefined || p.sell !== undefined)
      fields[7] = parseFloat(p.sellprice || p.sell) || 0;
    if (p.qty      !== undefined) fields[8]  = parseInt(p.qty) || 0;
    if (p.supplier !== undefined) fields[9]  = p.supplier;
    if (p.buydate  !== undefined) fields[10] = p.buydate;   // ✅ FIX 3
    if (p.lowestbuy !== undefined) fields[11] = parseFloat(p.lowestbuy) || 0;
    if (p.image    !== undefined) fields[12] = p.image;
    return updateRow(invS, p.id, fields);
  }

  if (action === 'deleteProduct') {
    return deleteRow(invS, p.id);
  }

  if (action === 'restock') {
    const qty   = parseInt(p.qty)    || 0;
    const price = parseFloat(p.price) || 0;
    const invData = invS.getDataRange().getValues();
    let found = false;
    for (let i = 1; i < invData.length; i++) {
      if (String(invData[i][0]) === String(p.productId)) {
        found = true;
        const newQty    = (parseInt(invData[i][8])   || 0) + qty;
        const curLowest = parseFloat(invData[i][11]) || price;
        invS.getRange(i+1, 7).setValue(price);
        invS.getRange(i+1, 9).setValue(newQty);
        invS.getRange(i+1, 10).setValue(p.supplier || invData[i][9]);
        invS.getRange(i+1, 11).setValue(p.date || new Date().toISOString().slice(0,10));
        invS.getRange(i+1, 12).setValue(Math.min(curLowest, price));
        break;
      }
    }
    // ✅ FIX 4: error return if not found
    if (!found) return out({ error: 'Product not found: ' + p.productId });
    rsS.appendRow([
      'RS' + Date.now(),
      p.productId   || '',
      p.productName || '',
      qty,
      price,
      p.supplier || '',
      p.date     || new Date().toISOString().slice(0,10),
      p.note     || ''
    ]);
    return out({ success: true });
  }

  if (action === 'updateSold') {
    const qty  = parseInt(p.qty) || 1;
    const date = p.date || new Date().toISOString().slice(0,10);
    const invData = invS.getDataRange().getValues();
    for (let i = 1; i < invData.length; i++) {
      if (String(invData[i][0]) === String(p.id)) {
        const cur = parseInt(invData[i][13]) || 0;
        invS.getRange(i+1, 14).setValue(cur + qty); // TotalSold
        invS.getRange(i+1, 15).setValue(date);       // LastSoldDate
        return out({ success: true });
      }
    }
    return out({ error: 'Product not found' });
  }

  // ── ORDERS ──

  if (action === 'addOrder') {
    // ✅ FIX 1: admin থেকে আসা ID use করো, না হলে generate
    const id = p.id || ('ORD-' + Date.now().toString().slice(-6));
    const itemsJson = p.items
      ? (typeof p.items === 'string' ? p.items : JSON.stringify(p.items))
      : '[]';
    ordS.appendRow([
      id,
      p.parcelId     || '',
      p.trackingLink || '',
      p.customer     || '',
      p.phone        || '',
      p.product      || '',
      p.productId    || '',
      p.variant      || '',
      parseInt(p.qty)    || 1,
      parseFloat(p.total) || 0,
      p.status || 'pending',
      p.date   || new Date().toISOString().slice(0,10),
      p.note   || '',
      itemsJson
    ]);
    return out({ success: true, id });
  }

  if (action === 'updateOrder') {
    const fields = {};
    if (p.parcelId     !== undefined) fields[1]  = p.parcelId;
    if (p.trackingLink !== undefined) fields[2]  = p.trackingLink;
    if (p.customer     !== undefined) fields[3]  = p.customer;
    if (p.phone        !== undefined) fields[4]  = p.phone;
    if (p.product      !== undefined) fields[5]  = p.product;
    if (p.productId    !== undefined) fields[6]  = p.productId;
    if (p.variant      !== undefined) fields[7]  = p.variant;
    if (p.qty          !== undefined) fields[8]  = parseInt(p.qty) || 1;
    if (p.total        !== undefined) fields[9]  = parseFloat(p.total) || 0;
    if (p.status       !== undefined) fields[10] = p.status;
    if (p.date         !== undefined) fields[11] = p.date;
    if (p.note         !== undefined) fields[12] = p.note;
    if (p.items        !== undefined) {
      fields[13] = typeof p.items === 'string' ? p.items : JSON.stringify(p.items);
    }
    return updateRow(ordS, p.id, fields);
  }

  if (action === 'deleteOrder') {
    return deleteRow(ordS, p.id);
  }

  if (action === 'updateOrderStatus') {
    return updateRow(ordS, p.id, { 10: p.status });
  }

  if (action === 'updateTracking') {
    const fields = {};
    if (p.parcelId     !== undefined) fields[1]  = p.parcelId;
    if (p.trackingLink !== undefined) fields[2]  = p.trackingLink;
    if (p.status       !== undefined) fields[10] = p.status;
    return updateRow(ordS, p.id, fields);
  }

  // ── SUPPLIERS ──

  if (action === 'addSupplier') {
    const id = 'S' + Date.now();
    supS.appendRow([id, p.name||'', p.phone||'', p.phone2||'', p.phone3||'', p.address||'']);
    return out({ success: true, id });
  }

  if (action === 'updateSupplier') {
    return updateRow(supS, p.id, {
      1: p.name    || '',
      2: p.phone   || '',
      3: p.phone2  || '',
      4: p.phone3  || '',
      5: p.address || ''
    });
  }

  if (action === 'deleteSupplier') {
    return deleteRow(supS, p.id);
  }

  return out({ error: 'Unknown action: ' + action });
}

// ── Helpers ──

function getData(s) {
  const d = s.getDataRange().getValues();
  if (d.length < 2) return [];
  const h = d[0].map(k => k.toString().toLowerCase().replace(/\s+/g, ''));
  return d.slice(1)
    .filter(r => r[0] !== '')
    .map(r => {
      const obj = {};
      h.forEach((k, i) => { obj[k] = r[i] !== undefined ? String(r[i]) : ''; });
      return obj;
    });
}

function getOrderData(s) {
  const d = s.getDataRange().getValues();
  if (d.length < 2) return [];
  const h = d[0].map(k => k.toString().toLowerCase().replace(/\s+/g, ''));
  return d.slice(1)
    .filter(r => r[0] !== '')
    .map(r => {
      const obj = {};
      h.forEach((k, i) => { obj[k] = r[i] !== undefined ? String(r[i]) : ''; });
      if (obj.items) {
        try { obj.items = JSON.parse(obj.items); }
        catch(e) { obj.items = []; }
      } else {
        obj.items = [];
      }
      return obj;
    });
}

function updateRow(s, id, fields) {
  const d = s.getDataRange().getValues();
  for (let i = 1; i < d.length; i++) {
    if (String(d[i][0]) === String(id)) {
      Object.entries(fields).forEach(([col, val]) => {
        s.getRange(i + 1, parseInt(col) + 1).setValue(val);
      });
      return out({ success: true });
    }
  }
  return out({ error: 'Not found: ' + id });
}

function deleteRow(s, id) {
  const d = s.getDataRange().getValues();
  for (let i = 1; i < d.length; i++) {
    if (String(d[i][0]) === String(id)) {
      s.deleteRow(i + 1);
      return out({ success: true });
    }
  }
  return out({ error: 'Not found: ' + id });
}
