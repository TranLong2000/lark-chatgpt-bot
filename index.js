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
const SPREADSHEET_TOKEN = process.env.SPREADSHEET_TOKEN || 'LYYqsXmnPhwwGHtKP00lZ1IWgDb';
const SHEET_ID = process.env.SHEET_ID || '48e2fd';
const GROUP_CHAT_IDS = (process.env.LARK_GROUP_CHAT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const BOT_OPEN_ID = process.env.BOT_OPEN_ID;
const BOT_SENDER_ID = process.env.BOT_SENDER_ID;
const AI_MODEL = process.env.AI_MODEL || 'deepseek/deepseek-r1-0528:free';

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
  if (!encryptKey) {
    console.error('LARK_ENCRYPT_KEY is not set');
    return false;
  }
  const raw = `${timestamp}${nonce}${encryptKey}${body}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  return hash === signature;
}

function decryptMessage(encrypt) {
  const key = Buffer.from(process.env.LARK_ENCRYPT_KEY || '', 'utf-8');
  if (key.length === 0) {
    throw new Error('LARK_ENCRYPT_KEY is not set');
  }
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
      { 
        app_id: process.env.LARK_APP_ID, 
        app_secret: process.env.LARK_APP_SECRET 
      },
      { timeout: 20000 }
    );
    return resp.data.app_access_token;
  } catch (error) {
    console.error('Error getting app access token:', error.message);
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
  } catch (error) {
    console.error('Error replying to Lark:', error.message);
  }
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
  } catch (error) {
    console.error('Error extracting file content:', error.message);
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
  } catch (error) {
    console.error('Error getting table meta:', error.message);
    return [];
  }
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
    } catch (error) {
      console.error('Error getting rows:', error.message);
      break;
    }
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
      console.error('Error getting sheet data:', err.message);
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

const SALE_COL_MAP = { A:0,E:4,F:5,G:6,M:12,N:13,O:14,P:15,Q:16,AK:36 };
let lastTotalStock = null;
let sendingTotalStockLock = false;
let lastSalesMsgHash = null;

async function getSaleComparisonData(token, prevCol, currentCol) {
  const col = SALE_COL_MAP;
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
          const totalStock  = toNumber(r[col.G]);
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
      console.error('❌ getSaleComparisonData error attempt', attempt, err?.message || err);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return [];
}

async function analyzeSalesChange(token) {
  try {
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
    }
    return msg;
  } catch (err) {
    console.error('❌ analyzeSalesChange error:', err?.message || err);
    return null;
  }
}

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
  } catch (err) {
    console.error('❌ getTotalStock error:', err?.message || err);
    return null;
  }
}

async function sendMessageToGroup(token, chatId, messageText) {
  try {
    const payload = { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: messageText }) };
    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('❌ sendMessageToGroup error to', chatId, err?.response?.data || err?.message || err);
  }
}

async function checkTotalStockChange() {
  if (sendingTotalStockLock) {
    console.log('⚠ checkTotalStockChange: đang có tiến trình gửi - bỏ qua lần này');
    return;
  }
  sendingTotalStockLock = true;

  try {
    const token = await getAppAccessToken();
    const currentTotalStock = await getTotalStock(token);

    if (currentTotalStock !== null && currentTotalStock !== lastTotalStock && lastTotalStock !== null) {
      console.log(`🔄 TotalStock thay đổi: ${lastTotalStock} → ${currentTotalStock}`);

      const uniqueGroupIds = Array.isArray(GROUP_CHAT_IDS) ? [...new Set(GROUP_CHAT_IDS.filter(Boolean))] : [];

      const stockMsg = `✅ Đã đổ Stock. Số lượng: ${currentTotalStock} thùng`;
      for (const chatId of uniqueGroupIds) {
        try {
          await sendMessageToGroup(token, chatId, stockMsg);
        } catch (err) {
          console.error('❌ Lỗi gửi Stock message to', chatId, err?.message || err);
        }
      }

      const salesMsg = await safeAnalyzeSalesChange(token);
      if (salesMsg && typeof salesMsg === 'string') {
        const hash = (s) => s ? String(s).slice(0,500) : '';
        const h = hash(salesMsg);
        if (h !== lastSalesMsgHash) {
          for (const chatId of uniqueGroupIds) {
            try {
              await sendMessageToGroup(token, chatId, salesMsg);
            } catch (err) {
              console.error('❌ Lỗi gửi Sales message to', chatId, err?.message || err);
            }
          }
          lastSalesMsgHash = h;
        } else {
          console.log('ℹ Sales message giống lần trước → không gửi lại');
        }
      } else {
        console.log('ℹ analyzeSalesChange trả về rỗng/null → không gửi Sales message');
      }
    } else {
      console.log('ℹ checkTotalStockChange: Không có thay đổi TotalStock hoặc lần chạy đầu.');
    }

    lastTotalStock = currentTotalStock;
  } catch (err) {
    console.error('❌ checkTotalStockChange error:', err?.message || err);
  } finally {
    sendingTotalStockLock = false;
  }
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

/* ===========================================
   SECTION 14 — Webhook (ONLY on @mention) — OPTIMIZED TOKEN
   =========================================== */
app.post('/webhook', async (req, res) => {
  try {
    const bodyRaw = req.body.toString('utf8');
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      console.error('Signature verification failed');
      return res.sendStatus(401);
    }

    let decryptedData = {};
    try { 
      decryptedData = decryptMessage(JSON.parse(bodyRaw).encrypt || ''); 
    } catch (e) {
      console.error('Decrypt error:', e);
      return res.sendStatus(400);
    }

    if (decryptedData.header?.event_type === 'im.chat.member.bot.added_v1') {
      return res.sendStatus(200);
    }

    if (decryptedData.header?.event_type === 'im.message.receive_v1') {
      const message = decryptedData.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const chatType = message.chat_type;
      const messageType = message.message_type;
      const senderId = decryptedData.event.sender?.sender_id?.open_id || null;
      const mentions = message.mentions || [];

      if (!senderId) {
        console.warn('No senderId found in message');
        return res.sendStatus(200);
      }

      if (processedMessageIds.has(messageId)) return res.sendStatus(200);
      processedMessageIds.add(messageId);

      if (senderId === BOT_SENDER_ID) return res.sendStatus(200);

      const botMentioned = mentions.some(m =>
        (m.id?.open_id && m.id.open_id === BOT_OPEN_ID) ||
        (m.id?.app_id && m.id.app_id === process.env.LARK_APP_ID)
      );

      if (chatType === 'group' && !botMentioned) return res.sendStatus(200);

      res.sendStatus(200);

      const token = await getAppAccessToken();

      let mentionUserName = 'Unknown User';
      try {
        const tmpName = await getUserInfo(senderId, token);
        if (tmpName) mentionUserName = tmpName;
      } catch (err) {
        console.error('getUserInfo error:', err?.response?.data || err.message);
      }
      const mentionUserId = senderId;

      let messageContent = '';
      try {
        const parsedContent = JSON.parse(message.content);
        messageContent = parsedContent.text || '';
        
        messageContent = messageContent
          .replace(/<at.*?<\/at>/g, '')
          .replace(/@L-GPT/gi, 'bạn')
          .trim();
      } catch {
        messageContent = '';
      }

      if (messageType === 'text' && messageContent) {
        try {
          // === Giới hạn bộ nhớ hội thoại ===
          const MAX_HISTORY = 10; // Chỉ giữ 10 lượt hội thoại gần nhất
          updateConversationMemory(chatId, 'user', messageContent, mentionUserName);
          let memory = conversationMemory.get(chatId) || [];

          // Nếu bộ nhớ quá dài -> tóm tắt phần cũ
          if (memory.length > MAX_HISTORY) {
            const oldPart = memory.slice(0, memory.length - MAX_HISTORY);
            const oldText = oldPart.map(m => `${m.role}: ${m.content}`).join('\n');

            try {
              const summaryResp = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                  model: AI_MODEL,
                  messages: [
                    { role: 'system', content: 'Tóm tắt đoạn hội thoại sau thành 1-2 câu ngắn, giữ nguyên ý chính:' },
                    { role: 'user', content: oldText }
                  ],
                  stream: false,
                  temperature: 0.3,
                  max_tokens: 200
                },
                { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } }
              );

              const summaryText = summaryResp.data.choices?.[0]?.message?.content?.trim() || '';
              memory = [{ role: 'system', content: `Tóm tắt trước đó: ${summaryText}` }, ...memory.slice(-MAX_HISTORY)];
              conversationMemory.set(chatId, memory);
            } catch (e) {
              console.error('Summary error:', e.message);
              memory = memory.slice(-MAX_HISTORY);
              conversationMemory.set(chatId, memory);
            }
          }

          const formattedHistory = memory.map(m => ({
            role: m.role,
            content: m.content
          }));

          // === Rút gọn System Prompt ===
          const systemPrompt = `Bạn là L-GPT, trợ lý AI thân thiện. 
Luôn gọi người dùng là "${mentionUserName}", 
không bao giờ dùng user1, user2... Trả lời ngắn gọn, rõ ràng, tự nhiên.`;

          let assistantMessage = 'Xin lỗi, tôi gặp sự cố khi xử lý yêu cầu của bạn.';

          try {
            const aiResp = await axios.post(
              'https://openrouter.ai/api/v1/chat/completions',
              {
                model: AI_MODEL,
                messages: [
                  { role: 'system', content: systemPrompt },
                  ...formattedHistory,
                  { role: 'user', content: messageContent }
                ],
                stream: false,
                temperature: 0.7,
                max_tokens: 5000
              },
              { 
                headers: { 
                  Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 
                  'Content-Type': 'application/json' 
                }, 
                timeout: 30000 
              }
            );

            assistantMessage = aiResp.data.choices?.[0]?.message?.content || assistantMessage;

            // Thay userX bằng tên thật
            if (assistantMessage.match(/user\d+/i)) {
              assistantMessage = assistantMessage.replace(/user\d+/gi, mentionUserName);
            }
            
          } catch (err) {
            console.error('AI API error:', err?.response?.data || err.message);
            assistantMessage = `Hiện tại tôi đang gặp sự cố kỹ thuật. ${mentionUserName} vui lòng thử lại sau nhé!`;
          }

          const cleanMessage = assistantMessage
            .replace(/[\*_`~]/g, '')
            .trim();

          updateConversationMemory(chatId, 'assistant', cleanMessage, 'L-GPT');

          await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
          
        } catch (err) {
          console.error('Text process error:', err);
          await replyToLark(messageId, `Xin lỗi ${mentionUserName}, tôi gặp lỗi khi xử lý tin nhắn của bạn.`, mentionUserId, mentionUserName);
        }
        return;
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Webhook global error:', error);
    return res.sendStatus(500);
  }
});

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
  console.log(`Server running on port ${port}`);
  checkTotalStockChange();
  setInterval(checkTotalStockChange, 60 * 1000);
});
