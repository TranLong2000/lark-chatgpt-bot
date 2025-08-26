// =========================
// index.js — L-GPT (Lark)
// =========================

/* ===== Core deps ===== */
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const Tesseract = require('tesseract.js');
const moment = require('moment-timezone');
const QuickChart = require('quickchart-js');
require('dotenv').config();

/* ===== App boot ===== */
const app = express();
const port = process.env.PORT || 8080;

/* ===============================
   SECTION 1 — Config mappings
   =============================== */
const BASE_MAPPINGS = {
  PUR:  'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbl61rgzOwS8viB2&view=vewi5cxZif',
  SALE: 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tblClioOV3nPN6jM&view=vew7RMyPed',
  FIN:  'https://cgfscmkep8m.sg.larksuite.com/base/Um8Zb07ayaDFAws9BRFlbZtngZf?table=tblc0IuDKdYrVGqo&view=vewU8BLeBr',
  TEST: 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbllwXLQBdRgex9z&view=vewksBlcon',
  PAY:  'https://cgfscmkep8m.sg.larksuite.com/base/UBrwbz2tHaeEwosVO5dlV0Lcgqb?table=tblQcpErvmsBpWCh&view=vewIQhfi04'
};

const SHEET_MAPPINGS = {
  PUR_SHEET: 'https://cgfscmkep8m.sg.larksuite.com/sheets/Qd5JsUX0ehhqO9thXcGlyAIYg9g?sheet=6eGZ0D'
};

/* ===============================
   SECTION 2 — Global constants
   =============================== */
let lastB2Value = null;
const SPREADSHEET_TOKEN = 'LYYqsXmnPhwwGHtKP00lZ1IWgDb';
const SHEET_ID = '48e2fd';
const GROUP_CHAT_IDS = (process.env.LARK_GROUP_CHAT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const BOT_OPEN_ID = process.env.BOT_OPEN_ID;

/* ===============================
   SECTION 3 — Runtime stores
   =============================== */
const processedMessageIds = new Set();
const conversationMemory = new Map();
const pendingTasks = new Map();
const pendingFiles = new Map();

if (!fs.existsSync('temp_files')) fs.mkdirSync('temp_files');

/* ===============================
   SECTION 4 — Express middleware
   =============================== */
app.use('/webhook', express.raw({ type: '*/*', limit: '10mb', timeout: 60000 }));
app.use('/webhook-base', express.json({ limit: '10mb', timeout: 60000 }));

/* ========================================
   SECTION 5 — Verify & Decrypt utilities
   ======================================== */
function verifySignature(timestamp, nonce, body, signature) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  if (!encryptKey) return false;
  const raw = `${timestamp}${nonce}${encryptKey}${body}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  return hash === signature;
}

function decryptMessage(encrypt) {
  const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'utf-8');
  const aesKey = crypto.createHash('sha256').update(key).digest();
  const data = Buffer.from(encrypt, 'base64');
  const iv = data.slice(0, 16);
  const encryptedText = data.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return JSON.parse(decrypted.toString());
}

/* ===========================================
   SECTION 6 — Lark helpers (user & reply)
   =========================================== */
async function getUserInfo(openId, token) {
  try {
    const response = await axios.get(
      `${process.env.LARK_DOMAIN}/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return response.data.data.user.name || `User_${openId.slice(-4)}`;
  } catch {
    return `User_${openId.slice(-4)}`;
  }
}

async function getAppAccessToken() {
  try {
    const resp = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`,
      { app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET },
      { timeout: 20000 }
    );
    return resp.data.app_access_token;
  } catch {
    throw new Error('Lỗi lấy token');
  }
}

async function replyToLark(messageId, content, mentionUserId = null, mentionUserName = null) {
  try {
    const token = await getAppAccessToken();
    const isSelfMention = mentionUserId === BOT_OPEN_ID;
    const messageContent = (!isSelfMention && mentionUserId && mentionUserName)
      ? { text: `${content} <at user_id="${mentionUserId}">${mentionUserName}</at>` }
      : { text: content };

    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages/${messageId}/reply`,
      { msg_type: 'text', content: JSON.stringify(messageContent) },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch {}
}

/* ===================================================
   SECTION 7 — File/Image extract (PDF/DOCX/XLSX/OCR)
   =================================================== */
async function extractFileContent(fileUrl, fileType) {
  try {
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const buffer = Buffer.from(response.data);

    if (fileType === 'pdf') {
      const data = await pdfParse(buffer);
      return (data.text || '').trim();
    }
    if (fileType === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      return (result.value || '').trim();
    }
    if (fileType === 'xlsx') {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
      return sheet.map(row => (row || []).join(', ')).join('; ');
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileType)) {
      const result = await Tesseract.recognize(buffer, 'eng+vie');
      return (result.data.text || '').trim();
    }
    return 'Không hỗ trợ loại file này.';
  } catch {
    return 'Lỗi khi trích xuất nội dung file';
  }
}

/* =======================================
   SECTION 8 — Bitable & Sheets helpers
   ======================================= */
async function getTableMeta(baseId, tableId, token) {
  try {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/meta`;
    const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    return (resp.data.data.fields || []).map(f => ({ name: f.name, field_id: f.field_id }));
  } catch { return []; }
}

async function getAllRows(baseId, tableId, token, requiredFields = []) {
  if (global.lastRows && global.lastRows.baseId === baseId && global.lastRows.tableId === tableId) {
    return global.lastRows.rows;
  }
  const rows = [];
  let pageToken = '';
  do {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=20&page_token=${pageToken}`;
    try {
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: requiredFields.length ? { field_names: requiredFields.join(',') } : {},
        timeout: 30000
      });
      rows.push(...(resp.data?.data?.items || []));
      pageToken = resp.data?.data?.page_token || '';
    } catch { break; }
  } while (pageToken && rows.length < 200);
  global.lastRows = { baseId, tableId, rows };
  return rows;
}

async function getSheetData(spreadsheetToken, token, range = 'A:AK') {
  const base = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`;
  const url = `${base}/${range}${range.includes('?') ? '&' : '?'}valueRenderOption=FormattedValue`;
  const timeout = 60000, maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout });
      return resp?.data?.data?.valueRange?.values || [];
    } catch (err) {
      if (attempt === maxRetries) return [];
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return [];
}

/* ==================================================
   SECTION 9 — Utility funcs (columns, numbers, etc.)
   ================================================== */
function colToIndex(col) {
  let idx = 0;
  for (let i = 0; i < col.length; i++) idx = idx * 26 + (col.charCodeAt(i) - 64);
  return idx - 1;
}
function toNumber(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/* ==========================================================
   SECTION 10 — Sales compare + message (scheduled analysis)
   ========================================================== */
async function getSaleComparisonData(token, prevCol, currentCol) {
  const col = { A:0,E:4,F:5,G:6,M:12,N:13,O:14,P:15,Q:16,AK:36 };
  const prevIdx = colToIndex(prevCol);
  const currIdx = colToIndex(currentCol);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const freshToken = await getAppAccessToken();
      const rows = await getSheetData(SPREADSHEET_TOKEN, freshToken, `${SHEET_ID}!A:AK`);

      if (rows && rows.length > 1) {
        return rows.slice(1).map((r, i) => {
          const productName = r[col.E] ?? `Dòng ${i + 2}`;
          const warehouse   = r[col.F] ?? '';
          const totalStock  = toNumber(r[col.G]); // Đổi stock -> totalStock
          const avr7daysRaw = r[col.M] ?? '';
          const sale3day    = toNumber(r[col.N]);
          const sale2day    = toNumber(r[col.O]);
          const sale1day    = toNumber(r[col.P]);
          const finalStatus = (r[col.AK] ?? '').toString().trim();
          const prev    = toNumber(r[prevIdx]);
          const current = toNumber(r[currIdx]);
          let change = 0;
          if (prev === 0 && current > 0) change = Infinity;
          else if (prev > 0) change = ((current - prev) / prev) * 100;

          return { productName, warehouse, finalStatus, totalStock, avr7days: avr7daysRaw, sale3day, sale2day, sale1day, prev, current, change };
        });
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return [];
}

async function analyzeSalesChange(token) {
  const nowVN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const hourVN = nowVN.getHours();
  const prevCol = 'M';
  const currentCol = hourVN < 12 ? 'P' : 'Q';
  const currentLabel = hourVN < 12 ? 'hôm qua' : 'hôm nay';

  const allData = await getSaleComparisonData(token, prevCol, currentCol);
  if (!allData.length) return null;

  const topData = allData.filter(r =>
    r.warehouse === 'Binh Tan Warehouse' && String(r.avr7days).trim() !== ''
  );
  const totalData = allData.filter(r =>
    r.finalStatus === 'On sale' && r.warehouse === 'Binh Tan Warehouse' && String(r.avr7days).trim() !== ''
  );

  if (!topData.length) return 'Không có dữ liệu cho Warehouse: Binh Tan Warehouse';

  const totalIncrease = totalData.filter(r => r.change > 0).length;
  const totalDecrease = totalData.filter(r => r.change < 0).length;

  const increases = topData
    .filter(r => r.prev > 0 && r.current > 10 && (r.change >= 0 || r.change === Infinity))
    .sort((a,b) => (b.change === Infinity ? 1e12 : b.change) - (a.change === Infinity ? 1e12 : a.change))
    .slice(0,5);

  const decreases = topData
    .filter(r => r.prev > 10 && r.change < 0)
    .sort((a,b) => a.change - b.change)
    .slice(0,5);

  const allOOS = totalData
    .filter(r => Number(r.totalStock) === 0)
    .map(r => {
      let label = '';
      if (r.sale1day === 0 && r.sale2day === 0 && r.sale3day === 0) label = 'OOS > 3 ngày';
      else if (r.sale1day === 0 && r.sale2day === 0) label = 'OOS 2 ngày';
      else if (r.sale1day === 0) label = 'OOS 1 ngày';
      return { ...r, oosLabel: label };
    })
    .filter(r => r.oosLabel)
    .sort((a,b) => {
      const w = lbl => lbl.includes('> 3') ? 3 : lbl.includes('2') ? 2 : 1;
      return w(b.oosLabel) - w(a.oosLabel);
    });

  const outOfStock = allOOS.slice(0,5);

  let msg = `📊 Biến động Sale (WBT): AVG D-7 → ${currentLabel}:\n`;
  if (increases.length) {
    msg += `\n🔥 Top 5 tăng mạnh / Tổng ${totalIncrease} SKU tăng:\n`;
    increases.forEach(r => {
      const pct = r.change === Infinity ? '+∞%' : `+${r.change.toFixed(1)}%`;
      msg += `- ${r.productName}: ${r.prev} → ${r.current} (${pct})\n`;
    });
  }
  if (decreases.length) {
    msg += `\n📉 Top 5 giảm mạnh / Tổng ${totalDecrease} SKU giảm:\n`;
    decreases.forEach(r => { msg += `- ${r.productName}: ${r.prev} → ${r.current} (${r.change.toFixed(1)}%)\n`; });
  }
  if (outOfStock.length) {
    msg += `\n🚨 SKU hết hàng / Tổng ${allOOS.length} SKU OOS:\n`;
    outOfStock.forEach(r => { msg += `- ${r.productName} (${r.oosLabel})\n`; });
    if (allOOS.length > 5) msg += `... và ${allOOS.length - 5} SKU khác.\n`;
  }
  return msg;
}

// Hàm an toàn: thử lại 3 lần nếu chưa có dữ liệu
async function safeAnalyzeSalesChange(token) {
  let tries = 3;
  while (tries > 0) {
    const msg = await analyzeSalesChange(token);
    if (msg && typeof msg === "string") return msg;
    await new Promise(r => setTimeout(r, 60000));
    tries--;
  }
  return "⚠ Dữ liệu vẫn chưa đủ để phân tích sau 3 lần thử.";
}

// Lấy tổng stock từ cột G
async function getTotalStock(token) {
  try {
    const targetColumn = 'G';
    const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${SHEET_ID}!${targetColumn}:${targetColumn}`;
    const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    const values = resp.data.data.valueRange.values || [];
    const sum = values.reduce((acc, row) => {
      const v = row[0];
      const num = parseFloat((v ?? '').toString().replace(/,/g, ''));
      return isNaN(num) ? acc : acc + num;
    }, 0);
    return (sum || sum === 0) ? sum.toString() : null;
  } catch {
    return null;
  }
}

// Gửi tin nhắn vào nhóm
async function sendMessageToGroup(token, chatId, messageText) {
  try {
    const payload = { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: messageText }) };
    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {}
}

// Biến lưu giá trị TotalStock lần trước
let lastTotalStock = null;

// Kiểm tra thay đổi TotalStock và gửi tin nhắn
async function checkTotalStockChange() {
  try {
    const token = await getAppAccessToken();
    const currentTotalStock = await getTotalStock(token);

    if (currentTotalStock !== null && currentTotalStock !== lastTotalStock && lastTotalStock !== null) {
      console.log(`🔄 TotalStock thay đổi: ${lastTotalStock} → ${currentTotalStock}`);

      // Gửi thông báo Đã đổ Stock
      const messageText = `✅ Đã đổ Stock. Số lượng: ${currentTotalStock} thùng`;
      for (const chatId of GROUP_CHAT_IDS) await sendMessageToGroup(token, chatId, messageText);

      // Gửi Sale compare ngay sau khi thay đổi stock
      const salesMsg = await safeAnalyzeSalesChange(token);
      if (salesMsg) {
        for (const chatId of GROUP_CHAT_IDS) await sendMessageToGroup(token, chatId, salesMsg);
      }
    }

    lastTotalStock = currentTotalStock;
  } catch (err) {}
}


/* =======================================================
   SECTION 11 — Conversation memory (short, rolling window)
   ======================================================= */
function updateConversationMemory(chatId, role, content, senderName = null) {
  if (!conversationMemory.has(chatId)) conversationMemory.set(chatId, []);
  const mem = conversationMemory.get(chatId);
  mem.push({ role, content, senderName });
  if (mem.length > 20) mem.shift();
}

/* =======================================================
   SECTION 12 — Natural language → Sheet action (Plan)
   ======================================================= */
async function interpretSheetQuery(userMessage, columnData) {
  try {
    const prompt = `
Bạn là trợ lý phân tích bảng. Tôi cung cấp:
1) Câu hỏi user: """${userMessage}"""
2) Danh sách cột: ${JSON.stringify(Object.keys(columnData))}
Chỉ trả về JSON:
{ "action": "value|sum|avg|percent_change|count", "target_column": "...", "match_column": "...", "match_value": "...", "note": "..." }
`;
    const aiResp = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-r1-0528:free',
        messages: [
          { role: 'system', content: 'Bạn là trợ lý AI chọn đúng cột từ header để tính nhanh.' },
          { role: 'user', content: prompt }
        ],
        stream: false
      },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const aiContent = aiResp.data?.choices?.[0]?.message?.content?.trim();
    if (!aiContent) return null;
    try { return JSON.parse(aiContent); }
    catch {
      const m = aiContent.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
      return null;
    }
  } catch (err) {
    return null;
  }
}

async function processPlanQuery(messageId, spreadsheetToken, userMessage, token, mentionUserId, mentionUserName) {
  try {
    const sheetData = await getSheetData(spreadsheetToken, token, 'A:AL');
    if (!sheetData || !sheetData.length) {
      await replyToLark(messageId, 'Không có dữ liệu.', mentionUserId, mentionUserName);
      return;
    }
    const headers = sheetData[0].map(h => (h ? h.toString().trim() : ''));
    const rows = sheetData.slice(1).map(r => r.map(c => (c == null ? '' : c.toString().trim())));
    const headerToIndex = {}; headers.forEach((h,i)=> headerToIndex[h]=i);
    const columnData = {}; headers.forEach((h,idx)=> columnData[h || `Column_${idx}`] = rows.map(r => r[idx] || ''));

    const interpretation = await interpretSheetQuery(userMessage, columnData);
    if (!interpretation || !interpretation.action || !interpretation.target_column) {
      await replyToLark(messageId, 'Câu chưa rõ. Ví dụ: "Plan, hôm nay bán bao nhiêu thùng Lager".', mentionUserId, mentionUserName);
      return;
    }

    const tcol = interpretation.target_column;
    let targetColIdx = /^[A-Z]+$/.test(tcol) ? colToIndex(tcol) : headerToIndex[tcol];
    const mcol = interpretation.match_column;
    let matchColIdx = mcol ? (/^[A-Z]+$/.test(mcol) ? colToIndex(mcol) : headerToIndex[mcol]) : null;
    const matchValue = interpretation.match_value;
    const action = interpretation.action;

    const parseNum = v => {
      if (v === '' || v == null) return NaN;
      const cleaned = v.toString().replace(/[^\d.\-]/g, '');
      const n = parseFloat(cleaned);
      return isNaN(n) ? NaN : n;
    };

    let resultText = '';
    if (action === 'value') {
      if (matchColIdx == null || matchValue == null) resultText = 'Thiếu điều kiện lọc.';
      else if (targetColIdx == null) resultText = 'Không xác định cột.';
      else {
        const foundRow = rows.find(r =>
          (r[matchColIdx] || '').toLowerCase().includes(String(matchValue).toLowerCase())
        );
        resultText = foundRow
          ? `${headers[targetColIdx]} = ${foundRow[targetColIdx]}`
          : `Không tìm thấy "${matchValue}".`;
      }
    } else if (['sum','avg','count'].includes(action)) {
      if (targetColIdx == null) resultText = 'Không xác định cột.';
      else {
        let filtered = rows;
        if (matchColIdx != null && matchValue != null) {
          filtered = rows.filter(r => (r[matchColIdx] || '').toLowerCase().includes(String(matchValue).toLowerCase()));
        }
        const nums = filtered.map(r => parseNum(r[targetColIdx])).filter(n => !isNaN(n));
        if (!nums.length) resultText = 'Không có số liệu.';
        else {
          if (action === 'sum') resultText = `Tổng ${headers[targetColIdx]}: ${nums.reduce((a,b)=>a+b,0)}`;
          if (action === 'avg') resultText = `TB ${headers[targetColIdx]}: ${(nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(2)}`;
          if (action === 'count') resultText = `Số dòng: ${nums.length}`;
        }
      }
    } else {
      resultText = 'Không hỗ trợ.';
    }

    await replyToLark(messageId, resultText, mentionUserId, mentionUserName);
  } catch (err) {
    await replyToLark(messageId, 'Lỗi xử lý Plan.', mentionUserId, mentionUserName);
  } finally {
    pendingTasks.delete(messageId);
  }
}

/* =======================================================
   SECTION 13 — Bitable command handler (processBaseData)
   ======================================================= */
async function processBaseData(messageId, baseId, tableId, userMessage, token) {
  try {
    const fields = await getTableMeta(baseId, tableId, token);
    const fieldNameById = Object.fromEntries(fields.map(f => [f.field_id, f.name]));
    const items = await getAllRows(baseId, tableId, token);

    if (!items.length) {
      await replyToLark(messageId, 'Bảng trống.', null, null);
      return;
    }

    const sample = items.slice(0, 3).map((it, idx) => {
      const kv = Object.entries(it.fields || {})
        .slice(0, 3)
        .map(([fid, val]) => `${fieldNameById[fid] || fid}: ${Array.isArray(val) ? JSON.stringify(val) : val}`)
        .join(' | ');
      return `${idx + 1}) ${kv}`;
    }).join('\n');

    const msg =
      `L-GPT: ${items.length} dòng.\n` +
      (sample ? `Mẫu:\n${sample}` : 'Không có mẫu.');

    await replyToLark(messageId, msg, null, null);
  } catch (err) {
    await replyToLark(messageId, 'Lỗi đọc Base.', null, null);
  } finally {
    pendingTasks.delete(messageId);
  }
}

// =======================
// Section 14 - Message Handling (A–E)
// =======================
if (messageType === 'image') {
  console.log('📷 Branch A: Xử lý ảnh');
  try {
    await handleImageMessage(messageId, chatId, mentionUserId, mentionUserName);
  } catch (err) {
    console.error('❌ Lỗi Branch A:', err?.message || err);
    await replyToLark(messageId, 'Không thể xử lý ảnh này.', mentionUserId, mentionUserName);
  }
  return;
}

if (messageType === 'file') {
  console.log('📂 Branch B: Xử lý file');
  try {
    await handleFileMessage(messageId, chatId, mentionUserId, mentionUserName);
  } catch (err) {
    console.error('❌ Lỗi Branch B:', err?.message || err);
    await replyToLark(messageId, 'Không thể xử lý file này.', mentionUserId, mentionUserName);
  }
  return;
}

if (messageType === 'audio') {
  console.log('🎤 Branch C: Xử lý audio');
  try {
    await handleAudioMessage(messageId, chatId, mentionUserId, mentionUserName);
  } catch (err) {
    console.error('❌ Lỗi Branch C:', err?.message || err);
    await replyToLark(messageId, 'Không thể xử lý audio này.', mentionUserId, mentionUserName);
  }
  return;
}

if (messageType === 'sticker') {
  console.log('😄 Branch D: Sticker');
  await replyToLark(messageId, '👍', mentionUserId, mentionUserName);
  return;
}

// =======================
// Branch E - Chat AI
// =======================
if (messageType === 'text') {
  console.log('💬 Branch E: Chat AI triggered');
  
  if (chatType === 'group' && !botMentioned) {
    console.log('ℹ BOT không được mention trong nhóm → bỏ qua');
    return;
  }
  if (!textAfterMention) {
    console.log('ℹ Không có nội dung sau mention → bỏ qua');
    return;
  }

  try {
    console.log('📝 Cập nhật bộ nhớ hội thoại...');
    updateConversationMemory(chatId, 'user', textAfterMention, mentionUserName);

    const memory = conversationMemory.get(chatId) || [];
    const formattedHistory = memory.map(m => (
      m.role === 'user'
        ? { role: 'user', content: `${m.senderName || 'User'}: ${m.content}` }
        : { role: 'assistant', content: `L-GPT: ${m.content}` }
    ));

    let aiResp;
    let retries = 3;

    while (retries > 0) {
      try {
        console.log(`🚀 Gọi API AI... Lần thử: ${4 - retries}`);
        aiResp = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'deepseek/deepseek-r1-0528:free',
            messages: [
              {
                role: 'system',
                content: 'Bạn tên là thư ký San San: luôn nghe lời sếp tên là Tran Long, đáng yêu nhưng chat ngắn gọn, súc tích.'
              },
              ...formattedHistory,
              { role: 'user', content: `${mentionUserName}: ${textAfterMention}` }
            ],
            stream: false
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 20000
          }
        );
        break; // nếu thành công → thoát vòng lặp
      } catch (err) {
        if (err?.response?.status === 429) {
          console.warn(`⚠ Quá tải (429) → chờ 3 giây rồi thử lại...`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          console.error(`❌ Lỗi gọi AI (Branch E):`, err?.response?.data || err.message);
          break;
        }
      }
      retries--;
    }

    if (!aiResp?.data?.choices?.[0]?.message?.content) {
      console.log('⚠ AI không trả về nội dung → báo lỗi người dùng');
      await replyToLark(messageId, 'Hiện hệ thống AI đang quá tải hoặc không trả lời.', mentionUserId, mentionUserName);
      return;
    }

    const assistantMessage =
      aiResp.data.choices[0].message.content || 'Không có kết quả.';
    const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();

    console.log('💾 Lưu phản hồi AI vào bộ nhớ...');
    updateConversationMemory(chatId, 'assistant', cleanMessage, 'L-GPT');

    console.log('📤 Gửi phản hồi về Lark...');
    await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);

  } catch (error) {
    console.error('🔥 Lỗi Branch E:', error?.response?.data || error.message);
    await replyToLark(
      messageId,
      'Hiện hệ thống AI đang quá tải, vui lòng thử lại sau ít phút.',
      mentionUserId,
      mentionUserName
    );
  }
  return;
}

/* ===========================================
   SECTION 15 — Housekeeping & Schedules
   =========================================== */
process.on('SIGTERM', () => {
  pendingTasks.forEach((task, messageId) =>
    replyToLark(messageId, 'Xử lý bị gián đoạn.', task.mentionUserId, task.mentionUserName)
  );
  process.exit(0);
});

setInterval(() => { conversationMemory.clear(); }, 2 * 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [chatId, file] of pendingFiles) {
    if (now - file.timestamp > 5 * 60 * 1000) pendingFiles.delete(chatId);
  }
}, 60 * 1000);

/* ===========================================
   SECTION 16 — Start server + stock watcher
   =========================================== */
app.listen(port, () => {
  checkTotalStockChange();
  setInterval(checkTotalStockChange, 60 * 1000);
});
