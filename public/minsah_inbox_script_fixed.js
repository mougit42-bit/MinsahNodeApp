// ============================================================
// MINSAH BEAUTY — FIXED Inbox Apps Script
// Sheet tab: Messages
// Columns: ID, SenderID, SenderName, Platform, PageID,
//          Message, Direction, Timestamp, Read, ConvID
// ============================================================

function doGet(e)  { return handleInbox(e); }
function doPost(e) { return handleInbox(e); }

// ── Sheet auto-create ──
function getSheet(ss) {
  let s = ss.getSheetByName('Messages');
  if (!s) {
    s = ss.insertSheet('Messages');
    s.appendRow([
      'ID','SenderID','SenderName','Platform','PageID',
      'Message','Direction','Timestamp','Read','ConvID'
    ]);
  }
  return s;
}

// ── JSON output helper ──
function out(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Main handler ──
function handleInbox(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = getSheet(ss);

  // ✅ GET params + POST body দুটোই support
  let p = e.parameter ? Object.assign({}, e.parameter) : {};
  if (e.postData && e.postData.contents) {
    try {
      const body = JSON.parse(e.postData.contents);
      p = Object.assign({}, p, body);
    } catch(err) {
      // POST body JSON না হলে form params try করো
      try {
        const params = e.postData.contents.split('&');
        params.forEach(param => {
          const [k, v] = param.split('=');
          if (k) p[decodeURIComponent(k)] = decodeURIComponent(v || '');
        });
      } catch(e2) {}
    }
  }

  const action = p.action || '';

  // ── getMessages ──
  if (action === 'getMessages') {
    const messages = getMessages(s);
    // ✅ FIX: {messages: [...]} format এ return করতে হবে
    // admin.html এ d.messages || [] expect করে
    return out({ messages: messages });
  }

  // ── saveMessage ──
  if (action === 'saveMessage') {
    const id  = Date.now() + '';
    const cid = p.convId || p.senderId || '';

    // ✅ FIX: message already decoded হলে double-decode এড়াতে safe decode
    let msg = p.message || '';
    try {
      // শুধু % থাকলে decode করো, না হলে as-is রাখো
      if (msg.includes('%')) msg = decodeURIComponent(msg);
    } catch(e) {
      // decode fail হলে original রাখো
    }

    s.appendRow([
      id,
      p.senderId   || '',
      p.senderName || '',
      p.platform   || 'fb',
      p.pageId     || '',
      msg,                                          // ✅ safe decoded message
      p.direction  || 'in',
      p.timestamp  || new Date().toISOString(),
      'false',
      cid
    ]);
    return out({ success: true, id: id });
  }

  // ── markRead ──
  if (action === 'markRead') {
    const convId = p.convId || '';
    if (!convId) return out({ error: 'convId required' });
    markRead(s, convId);
    return out({ success: true });
  }

  // ── deleteMessage (optional) ──
  if (action === 'deleteMessage') {
    const msgId = p.id || '';
    if (!msgId) return out({ error: 'id required' });
    const d = s.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      if (String(d[i][0]) === String(msgId)) {
        s.deleteRow(i + 1);
        return out({ success: true });
      }
    }
    return out({ error: 'Not found' });
  }

  return out({ error: 'Unknown action: ' + action });
}

// ── Get all messages ──
function getMessages(s) {
  const d = s.getDataRange().getValues();
  if (d.length < 2) return [];
  const h = d[0].map(k => k.toString().toLowerCase().replace(/\s+/g, ''));
  return d.slice(1)
    .filter(r => r[0] !== '')   // blank rows skip
    .map(r => {
      const o = {};
      h.forEach((k, i) => { o[k] = r[i] !== undefined ? String(r[i]) : ''; });
      return o;
    });
}

// ── Mark conversation as read ──
// ConvID = col index 9 (range col 10)
// Read   = col index 8 (range col 9)
function markRead(s, convId) {
  const d = s.getDataRange().getValues();
  for (let i = 1; i < d.length; i++) {
    // ✅ ConvID is index 9, Read is index 8
    if (String(d[i][9]) === String(convId)) {
      s.getRange(i + 1, 9).setValue('true');  // col 9 = Read ✅
    }
  }
}
