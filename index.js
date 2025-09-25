// =========================
// index.js — L-GPT (Lark)
// =========================

// Polyfill cho File / Blob / FormData trên Node <18
const { File, FormData, Blob } = require("formdata-node");
global.File = File;
global.FormData = FormData;
global.Blob = Blob;

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
const cron = require('node-cron');
const { createCanvas, registerFont } = require("canvas");
const cheerio = require("cheerio");
const bodyParser = require("body-parser");
const puppeteer = require('puppeteer');
const qs = require("qs");
const CryptoJS = require("crypto-js");
const { v4: uuidv4 } = require("uuid");
require('dotenv').config();

/* ===== App boot ===== */
const app = express();
const port = process.env.PORT || 8080;

/* ===============================
   SECTION 1 — Config mappings
   =============================== */

/* ===============================
   SECTION 2 — Global constants
   =============================== */

const GROUP_CHAT_IDS = (process.env.LARK_GROUP_CHAT_IDS || '')   
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const GROUP_CHAT_IDS_TEST = (process.env.LARK_GROUP_CHAT_IDS_TEST || '')   
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
      { timeout: 60000 }
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


/* =======================================
   SECTION 8 — Bitable & Sheets helpers
   ======================================= */

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

// ==== SHEET CONFIG ====
const SPREADSHEET_TOKEN_RAW = process.env.SPREADSHEET_TOKEN_RAW;     // sheet Raw (Sale data)
const SHEET_ID_RAW = process.env.SHEET_ID_RAW;                     // sheet id Raw

const SPREADSHEET_TOKEN_PAYMENT = process.env.SPREADSHEET_TOKEN_PAYMENT; // sheet Payment (Rebate)
const SHEET_ID_REBATE = process.env.SHEET_ID_REBATE;                     // sheet id Rebate

const SALE_COL_MAP = { 
  A: 0,    // không đổi
  F: 5,    // E -> F
  G: 6,    // F -> G
  H: 7,    // G -> H
  N: 13,   // M -> N
  O: 14,   // N -> O
  P: 15,   // O -> P
  Q: 16,   // P -> Q
  R: 17,   // Q -> R
  AL: 37   // AK -> AL
};
let lastTotalStock = null;
let sendingTotalStockLock = false;
let lastSalesMsgHash = null;

// ====================== GET SALES COMPARISON ======================
async function getSaleComparisonDataOnce(token, prevCol, currentCol) {
  try {
    const col = SALE_COL_MAP;
    const prevIdx = colToIndex(prevCol);
    const currIdx = colToIndex(currentCol);

    const freshToken = await getAppAccessToken();
    const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN_RAW}/values/${encodeURIComponent(`${SHEET_ID_RAW}!A:AL`)}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${freshToken}` },
      timeout: 20000,
      params: {
        valueRenderOption: 'FormattedValue',
        dateTimeRenderOption: 'FormattedString'
      }
    });

    const rows = resp.data?.data?.valueRange?.values || [];
    if (rows && rows.length > 1) {
      return rows.slice(1).map((r, i) => {
        const warehouseShort = r[col.A] ?? '';              // cột A (tên kho viết tắt)
        const productName    = r[col.F] ?? `Dòng ${i + 2}`; // cột F (tên sản phẩm)
        const warehouse   = r[col.G] ?? '';
        const totalStock  = toNumber(r[col.H]);
        const avr7daysRaw = r[col.N] ?? '';
        const sale3day    = toNumber(r[col.O]);
        const sale2day    = toNumber(r[col.P]);
        const sale1day    = toNumber(r[col.Q]);
        const finalStatus = (r[col.AL] ?? '').toString().trim();
        const prev        = toNumber(r[prevIdx]);
        const current     = toNumber(r[currIdx]);

        let change = 0;
        if (prev === 0 && current > 0) change = Infinity;
        else if (prev > 0) change = ((current - prev) / prev) * 100;

        return { 
          productName, 
          warehouseShort,   // 👈 thêm trường này
          warehouse, 
          finalStatus, 
          totalStock, 
          avr7days: avr7daysRaw, 
          sale3day, 
          sale2day, 
          sale1day, 
          prev, 
          current, 
          change 
        };
      });
    }
    return null;
  } catch (err) {
    console.error('❌ getSaleComparisonDataOnce error:', err?.message || err);
    return null;
  }
}

async function getSaleComparisonData(token, prevCol, currentCol) {
  const maxRetries = 3;
  const retryDelayMs = 20000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`📥 Lấy dữ liệu Sale (lần ${attempt}/${maxRetries})...`);
    const data = await getSaleComparisonDataOnce(token, prevCol, currentCol);
    if (data && data.length) {
      console.log(`✅ Lấy dữ liệu Sale thành công ở lần ${attempt}`);
      return data;
    }
    if (attempt < maxRetries) {
      console.log(`⏳ Đợi ${retryDelayMs / 1000}s rồi thử lại...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
  console.error('❌ Thử lấy dữ liệu Sale 3 lần nhưng thất bại.');
  return [];
}

// ====================== ANALYZE SALES CHANGE ======================
async function analyzeSalesChange(token) {
  try {
    const nowVN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    const hourVN = nowVN.getHours();

    // Cột đã dịch +1 so với phiên bản cũ
    const prevCol = 'N';              
    const currentCol = hourVN < 12 ? 'Q' : 'R'; 
    const currentLabel = hourVN < 12 ? 'hôm qua' : 'hôm nay';

    const allData = await getSaleComparisonData(token, prevCol, currentCol);
    if (!allData.length) return null;

    const topData = allData.filter(r =>
      r.warehouse !== 'Thu Duc Warehouse' && String(r.avr7days).trim() !== ''
    );
    const totalData = allData.filter(r =>
      r.finalStatus === 'On sale' &&
      r.warehouse !== 'Thu Duc Warehouse' &&
      String(r.avr7days).trim() !== ''
    );

    if (!topData.length) return 'Không có dữ liệu';

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

    // ===== OOS logic =====
    const oosCandidates = totalData.filter(
      r => Number(r.totalStock) === 0 && String(r.avr7days).trim() !== ''
    );
    const totalOosCount = oosCandidates.length;

    const getOosLabel = (r) => {
      if (r.sale1day === 0 && r.sale2day === 0 && r.sale3day === 0) return 'OOS > 3 ngày';
      if (r.sale1day === 0 && r.sale2day === 0) return 'OOS 2 ngày';
      if (r.sale1day === 0) return 'OOS 1 ngày';
      return '';
    };

    const outOfStock = oosCandidates
      .map(r => ({ ...r, oosLabel: getOosLabel(r) }))
      .filter(r => r.oosLabel)
      .sort((a,b) => {
        const w = lbl => lbl.includes('> 3') ? 3 : lbl.includes('2') ? 2 : 1;
        return w(b.oosLabel) - w(a.oosLabel);
      })
      .slice(0,5);
    // ======================

    // format tên hiển thị có [warehouseShort]
    const formatName = (r) => r.warehouseShort 
      ? `[${r.warehouseShort}] ${r.productName}` 
      : r.productName;

    let msg = `📊 Biến động Sale: AVG D-7 → ${currentLabel}:\n`;
    if (increases.length) {
      msg += `\n🔥 Top 5 tăng mạnh / Tổng ${totalIncrease} SKU tăng:\n`;
      increases.forEach(r => {
        const pct = r.change === Infinity ? '+∞%' : `+${r.change.toFixed(1)}%`;
        msg += `- ${formatName(r)}: ${r.prev} → ${r.current} (${pct})\n`;
      });
    }
    if (decreases.length) {
      msg += `\n📉 Top 5 giảm mạnh / Tổng ${totalDecrease} SKU giảm:\n`;
      decreases.forEach(r => {
        msg += `- ${formatName(r)}: ${r.prev} → ${r.current} (${r.change.toFixed(1)}%)\n`;
      });
    }
    if (totalOosCount > 0) {
      msg += `\n🚨 SKU hết hàng / Tổng ${totalOosCount} SKU OOS:\n`;
      outOfStock.forEach(r => {
        msg += `- ${formatName(r)} (${r.oosLabel})\n`;
      });
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
    await new Promise(r => setTimeout(r, 20000));
    tries--;
  }
  return "⚠ Dữ liệu vẫn chưa đủ để phân tích sau 3 lần thử.";
}

// ====================== GET TOTAL STOCK ======================
async function getTotalStockOnce(token) {
  try {
    // dịch từ A:G -> A:H vì thêm 1 cột
    const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN_RAW}/values/${SHEET_ID_RAW}!A:H`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
      params: {
        valueRenderOption: 'FormattedValue',
        dateTimeRenderOption: 'FormattedString'
      }
    });

    const rows = resp.data?.data?.valueRange?.values || [];
    if (!rows.length) return null;

    const filtered = rows.slice(1).filter(row => (row[0] || "").trim() === "WBT");
    const sum = filtered.reduce((acc, row) => {
      const v = row[7]; // trước là row[6]
      const num = parseFloat((v ?? '').toString().replace(/,/g, ''));
      return isNaN(num) ? acc : acc + num;
    }, 0);

    return (sum || sum === 0) ? sum.toString() : null;
  } catch (err) {
    console.error(`❌ getTotalStockOnce error:`, err?.message || err);
    return null;
  }
}

async function getTotalStock(token) {
  const maxRetries = 3;
  const retryDelayMs = 20000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`📥 Đang lấy dữ liệu Stock (lần ${attempt}/${maxRetries})...`);
    const stock = await getTotalStockOnce(token);
    if (stock !== null) {
      console.log(`✅ Lấy dữ liệu Stock thành công ở lần ${attempt}`);
      return stock;
    }
    if (attempt < maxRetries) {
      console.log(`⏳ Đợi ${retryDelayMs / 1000}s rồi thử lại...`);
      await new Promise(res => setTimeout(res, retryDelayMs));
    }
  }
  console.error('❌ Thử lấy dữ liệu Stock 3 lần nhưng đều thất bại.');
  return null;
}

// ====================== SEND MESSAGE ======================
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

// ====================== MAIN CHECK ======================
async function checkTotalStockChange() {
  if (sendingTotalStockLock) {
    console.log('⚠ checkTotalStockChange: đang có tiến trình gửi - bỏ qua lần này');
    return;
  }
  sendingTotalStockLock = true;

  try {
    const token = await getAppAccessToken();
    const currentTotalStock = await getTotalStock(token);

    if (
      currentTotalStock !== null &&
      lastTotalStock !== null &&
      currentTotalStock !== lastTotalStock
    ) {
      console.log(`🔄 TotalStock thay đổi: ${lastTotalStock} → ${currentTotalStock}`);

      const uniqueGroupIds = Array.isArray(GROUP_CHAT_IDS)
        ? [...new Set(GROUP_CHAT_IDS.filter(Boolean))]
        : [];

      const stockMsg = `✅ Đã đổ Stock. Số lượng (WBT): ${currentTotalStock} thùng`;
      for (const chatId of uniqueGroupIds) {
        await sendMessageToGroup(token, chatId, stockMsg);
      }

      const salesMsg = await safeAnalyzeSalesChange(token);
      if (salesMsg && typeof salesMsg === 'string') {
        const hash = (s) => s ? String(s).slice(0, 500) : '';
        const h = hash(salesMsg);
        if (h !== lastSalesMsgHash) {
          for (const chatId of uniqueGroupIds) {
            await sendMessageToGroup(token, chatId, salesMsg);
          }
          lastSalesMsgHash = h;
        } else {
          console.log('ℹ Sales message giống lần trước → không gửi lại');
        }
      }
    }

    lastTotalStock = currentTotalStock;
  } catch (err) {
    console.error('❌ checkTotalStockChange error:', err?.message || err);
  } finally {
    sendingTotalStockLock = false;
  }
}

/* ==========================================================
   SECTION 10.1 — Check Rebate (on demand) 
   ========================================================== */

function _parseNumber(v) {
  if (v === undefined || v === null || v === '') return 0;
  const cleaned = String(v).replace(/[,\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function _parseRemainsDay(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}

// parse từ cột AZ (m/d/yyyy)
function _parseMonthAndQuarter(dateStr) {
  if (!dateStr) return { month: null, quarter: null };
  const clean = String(dateStr).trim();
  const parts = clean.split('/');
  if (parts.length < 2) return { month: null, quarter: null };

  const month = parseInt(parts[0], 10);
  if (isNaN(month) || month < 1 || month > 12) {
    return { month: null, quarter: null };
  }
  const quarter = Math.floor((month - 1) / 3) + 1;
  return { month, quarter };
}

async function getRebateData(token) {
  const col = {
    AH: 1,   // PO
    AZ: 19,  // Rebate Date (m/d/yyyy)
    BA: 20,  // Supplier
    BC: 22,  // Actual Rebate
    BE: 24,  // Rebate Method
    BH: 27,  // Payment Method
    BI: 28   // Remains Day
  };

  const SPREADSHEET_TOKEN = SPREADSHEET_TOKEN_PAYMENT;
  const SHEET_ID = SHEET_ID_REBATE;
  const RANGE = `${SHEET_ID}!AG:BL`;

  console.log('[Rebate] RANGE', RANGE, '- columns count = 32 (AG..BL)');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const authToken = token || await getAppAccessToken();
      const url =
        `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values_batch_get` +
        `?ranges=${encodeURIComponent(RANGE)}&valueRenderOption=FormattedValue`;

      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 20000
      });

      const rows = resp.data?.data?.valueRanges?.[0]?.values || [];
      console.log(`DEBUG attempt ${attempt} - rebate sheet rows length:`, rows.length);

      if (rows && rows.length > 1) {
        return rows.slice(1).map(r => ({
          supplier: r[col.BA] ? String(r[col.BA]).trim() : '',
          rebateMethod: r[col.BE] ? String(r[col.BE]).trim() : '',
          po: r[col.AH] ? String(r[col.AH]).trim() : '',
          actualRebate: _parseNumber(r[col.BC]),
          paymentMethod: r[col.BH] ? String(r[col.BH]).trim() : '',
          remainsDay: _parseRemainsDay(r[col.BI]),
          rebateDateAZ: r[col.AZ] ? String(r[col.AZ]).trim() : ''
        }));
      }

      console.warn(`⚠ Attempt ${attempt}: Rebate data empty or too short, retrying...`);
      await new Promise(res => setTimeout(res, 2000));
    } catch (err) {
      console.error(`Error fetching rebate sheet (attempt ${attempt}):`, err?.message || err);
      await new Promise(res => setTimeout(res, 2000));
    }
  }

  return [];
}

async function analyzeRebateData(token) {
  const data = await getRebateData(token);
  if (!Array.isArray(data) || data.length === 0) {
    return "⚠ Không có dữ liệu Rebate.";
  }

  // Lọc dữ liệu hợp lệ
  const filtered = data.filter(row => {
    const method = String(row.rebateMethod || '').trim();
    return (
      method &&
      method !== '0' &&
      method.toLowerCase() !== 'rebate method' &&
      Number(row.actualRebate) !== 0
    );
  });

  if (filtered.length === 0) {
    return "⚠ Không có dữ liệu Rebate (sau khi lọc).";
  }

  // Gom nhóm theo rebateMethod
  const groupedByMethod = filtered.reduce((acc, row) => {
    const methodKey = String(row.rebateMethod).trim();
    if (!acc[methodKey]) acc[methodKey] = [];
    acc[methodKey].push(row);
    return acc;
  }, {});

  let msg = `📋 Báo cáo Rebate:\n`;

  for (const [method, rows] of Object.entries(groupedByMethod)) {
    msg += `\n💳 ${method}\n`;

    // Gom nhóm theo supplier
    const supplierGroup = rows.reduce((acc, r) => {
      const supplierName = r.supplier || '(Không xác định)';
      if (!acc[supplierName]) acc[supplierName] = [];
      acc[supplierName].push(r);
      return acc;
    }, {});

    for (const [supplier, supplierRows] of Object.entries(supplierGroup)) {
      const paymentMethod = supplierRows[0]?.paymentMethod || '';

      // Tổng rebate quá hạn
      const overdueTotal = supplierRows.reduce((sum, r) => {
        return r.remainsDay < 0 ? sum + (Number(r.actualRebate) || 0) : sum;
      }, 0);

      const overdueText = overdueTotal > 0
        ? ` → ${Math.round(overdueTotal).toLocaleString('en-US')}`
        : '';

      msg += `- ${supplier} (${paymentMethod})${overdueText}\n`;

      // Gom theo period
      const byPeriod = supplierRows.reduce((acc, r) => {
        let periodLabel = '';
        const { month, quarter } = _parseMonthAndQuarter(r.rebateDateAZ);

        if (method.toLowerCase() === 'monthly') {
          periodLabel = month ? `Tháng ${month}` : 'Tháng ?';
        } else if (method.toLowerCase() === 'quarterly') {
          periodLabel = quarter ? `Quý ${quarter}` : 'Quý ?';
        } else {
          periodLabel = r.po ? `PO ${r.po}` : '';
        }

        if (!acc[periodLabel]) {
          acc[periodLabel] = {
            label: periodLabel,
            poSet: new Set(),
            totalRebate: 0,
            remainsDay: r.remainsDay
          };
        }

        if (r.po) acc[periodLabel].poSet.add(r.po);
        acc[periodLabel].totalRebate += Number(r.actualRebate) || 0;
        acc[periodLabel].remainsDay = r.remainsDay;

        return acc;
      }, {});

      const rowsArr = Object.values(byPeriod).sort((a, b) => a.remainsDay - b.remainsDay);

      rowsArr.forEach(item => {
        const poCount = item.poSet.size;
        const totalFormatted = Math.round(item.totalRebate).toLocaleString('en-US');

        if (method.toLowerCase() === 'daily') {
          msg += `   • ${poCount} PO | ${totalFormatted} | ${item.remainsDay} ngày\n`;
        } else {
          msg += `   • ${item.label} | ${totalFormatted} | ${item.remainsDay} ngày\n`;
        }
      });
    }
  }

  return msg;
}

async function sendRebateReport() {
  try {
    const token = await getAppAccessToken();
    const reportMsg = await analyzeRebateData(token);
    if (!reportMsg) {
      console.warn('[Rebate] No report message to send.');
      return;
    }

    const uniqueGroupIds = Array.isArray(GROUP_CHAT_IDS) ? [...new Set(GROUP_CHAT_IDS.filter(Boolean))] : [];
    for (const chatId of uniqueGroupIds) {
      try {
        await sendMessageToGroup(token, chatId, reportMsg);
        console.log('[Rebate] Sent report to group', chatId);
      } catch (err) {
        console.error('[Rebate] Failed sending report to', chatId, err?.message || err);
      }
    }
  } catch (err) {
    console.error('Lỗi gửi báo cáo Rebate:', err?.message || err);
  }
}

/* ==================================================
   CRON JOBS — Gửi hình từ Google Sheet
   ================================================== */

// ===== Đăng ký font (file nằm cùng cấp index.js) =====
const fontPath = path.join(__dirname, "NotoSans-Regular.ttf");
registerFont(fontPath, { family: "NotoSans" });

// ===== Hàm render table thành ảnh (mock style + E2 màu xanh nhạt) =====
function renderTableToImage(values) {
  const cellWidth = 120;
  const cellHeight = 40;
  const rows = values.length;
  const cols = values[0].length;

  const canvas = createCanvas(cols * cellWidth, rows * cellHeight);
  const ctx = canvas.getContext("2d");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  values.forEach((row, i) => {
    row.forEach((val, j) => {
      const x = j * cellWidth;
      const y = i * cellHeight;

      let bgColor = "#ffffff"; // nền mặc định trắng

      // highlight E2 (cột E = index 4, dòng 2 = index 1)
      if (i === 1 && j === 4) {
        bgColor = "#ccffcc"; // xanh lá nhạt
      }

      // vẽ nền
      ctx.fillStyle = bgColor;
      ctx.fillRect(x, y, cellWidth, cellHeight);

      // viền
      ctx.strokeStyle = "#cccccc";
      ctx.strokeRect(x, y, cellWidth, cellHeight);

      // chữ
      ctx.fillStyle = "#000000";
      ctx.font = `16px NotoSans`;
      ctx.fillText(val || "", x + cellWidth / 2, y + cellHeight / 2);
    });
  });

  return canvas.toBuffer("image/png");
}

// ===== Upload ảnh buffer lên Lark (dùng formdata-node) =====
async function uploadImageFromBuffer(APP_ACCESS_TOKEN, buffer) {
  const form = new FormData();
  form.set("image_type", "message");
  form.set(
    "image",
    new File([buffer], "sheet.png", { type: "image/png" })
  );

  const res = await axios.post(
    `${process.env.LARK_DOMAIN}/open-apis/im/v1/images`,
    form,
    {
      headers: {
        ...form.headers, // 👈 formdata-node có headers riêng
        Authorization: `Bearer ${APP_ACCESS_TOKEN}`,
      },
    }
  );

  return res.data.data.image_key;
}

/* ==================================================
   Debug: In ra toàn bộ group bot đang tham gia
   ================================================== */

async function listAllGroups(APP_ACCESS_TOKEN) {
  try {
    let pageToken = null;
    let hasMore = true;

    while (hasMore) {
      const url = new URL(`${process.env.LARK_DOMAIN}/open-apis/im/v1/chats`);
      if (pageToken) url.searchParams.append("page_token", pageToken);
      url.searchParams.append("page_size", "50");

      const res = await axios.get(url.toString(), {
        headers: { Authorization: `Bearer ${APP_ACCESS_TOKEN}` },
      });

      const items = res.data?.data?.items || [];
      for (const g of items) {
        console.log(`📌 Group: ${g.name} | chat_id=${g.chat_id}`);
      }

      hasMore = res.data?.data?.has_more;
      pageToken = res.data?.data?.page_token;
    }
  } catch (err) {
    console.error("❌ [listAllGroups] Lỗi:", err?.response?.data || err.message);
  }
}

// 👉 Gọi thử sau khi lấy được APP_ACCESS_TOKEN
// const APP_ACCESS_TOKEN = await getAppAccessToken();
// await listAllGroups(APP_ACCESS_TOKEN);

// ===== Gửi ảnh vào group (nhiều chatId) =====
async function sendImageToGroup(APP_ACCESS_TOKEN, LARK_GROUP_CHAT_IDS, imageKey) {
  if (!Array.isArray(LARK_GROUP_CHAT_IDS)) return;

  for (const chatId of LARK_GROUP_CHAT_IDS.filter(Boolean)) {
    try {
      const payload = {
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      };

      await axios.post(
        `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        payload,
        { headers: { Authorization: `Bearer ${APP_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.error(`[sendImageToGroup] Failed to send to ${chatId}:`, err?.response?.data || err?.message || err);
    }
  }
}

/* ==================================================
   SECTION 1 — Cron gửi hình vùng A1:H7 (mock style, E2 xanh nhạt)
   ================================================== */

// Lấy values từ Sheet cố định
async function getSheetValues(APP_ACCESS_TOKEN, SPREADSHEET_TOKEN, SHEET_ID) {
  const RANGE = `${SHEET_ID}!A1:H7`;
  const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${encodeURIComponent(RANGE)}?valueRenderOption=FormattedValue`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${APP_ACCESS_TOKEN}` },
  });
  if (!res.data?.data?.valueRange?.values) {
    throw new Error("Không lấy được values từ Sheet API");
  }
  return res.data.data.valueRange.values;
}

// Hàm tổng hợp gửi Sheet mock
async function sendSheetAsImageWithMockStyle(APP_ACCESS_TOKEN, LARK_GROUP_CHAT_IDS, SPREADSHEET_TOKEN, SHEET_ID) {
  const values = await getSheetValues(APP_ACCESS_TOKEN, SPREADSHEET_TOKEN, SHEET_ID);
  const buffer = renderTableToImage(values);
  const imageKey = await uploadImageFromBuffer(APP_ACCESS_TOKEN, buffer);
  await sendImageToGroup(APP_ACCESS_TOKEN, LARK_GROUP_CHAT_IDS, imageKey);
}

// Cron mỗi 18:00 giờ VN
cron.schedule(
  "0 18 * * *",
  async () => {
    try {
      const APP_ACCESS_TOKEN = await getAppAccessToken();
      const LARK_GROUP_CHAT_IDS_TEST = process.env.LARK_GROUP_CHAT_IDS_TEST?.split(",") || [];
      const SPREADSHEET_TOKEN_TEST = process.env.SPREADSHEET_TOKEN_TEST;
      const SHEET_ID_TEST = process.env.SHEET_ID_TEST;

      await sendSheetAsImageWithMockStyle(APP_ACCESS_TOKEN, LARK_GROUP_CHAT_IDS_TEST, SPREADSHEET_TOKEN_TEST, SHEET_ID_TEST);
      console.log("✅ [Cron] Đã gửi hình (mock style, E2 xanh nhạt) từ Sheet vào group test!");
    } catch (err) {
      console.error("❌ [Cron] Lỗi khi gửi ảnh:", err?.response?.data || err.message);
    }
  },
  { scheduled: true, timezone: "Asia/Ho_Chi_Minh" }
);

/* ==================================================
   SECTION 2 — Cron gửi hình B1:H tới dòng cuối cột D
   ================================================== */

const SPREADSHEET_TOKEN_NEW = "LYYqsXmnPhwwGHtKP00lZ1IWgDb";
const SHEET_ID_NEW = "3UQxbQ";

// Lấy values động
async function getSheetValuesDynamic(APP_ACCESS_TOKEN, SPREADSHEET_TOKEN = SPREADSHEET_TOKEN_NEW, SHEET_ID = SHEET_ID_NEW) {
  const CHECK_RANGE = `${SHEET_ID}!B1:H200`;
  const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${encodeURIComponent(CHECK_RANGE)}?valueRenderOption=FormattedValue`;

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${APP_ACCESS_TOKEN}` },
  });

  if (!res.data?.data?.valueRange?.values) {
    throw new Error("Không lấy được values từ Sheet API");
  }

  const allValues = res.data.data.valueRange.values;
  let lastRow = 0;

  // tìm dòng cuối có dữ liệu ở cột D (trong B..H thì D = index 2)
  allValues.forEach((row, idx) => {
    const cellD = row[2];
    if (cellD !== undefined && cellD !== "") {
      lastRow = idx + 1;
    }
  });

  if (lastRow === 0) throw new Error("Cột D không có dữ liệu");

  // cắt mảng tới lastRow, pad thiếu cột = ""
  const values = allValues.slice(0, lastRow).map((row) => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      out.push(row[i] !== undefined ? row[i] : "");
    }
    return out;
  });

  return values;
}

// Hàm tổng hợp gửi Sheet dynamic
async function sendDynamicSheetAsImage(APP_ACCESS_TOKEN) {
  const values = await getSheetValuesDynamic(APP_ACCESS_TOKEN, SPREADSHEET_TOKEN_NEW, SHEET_ID_NEW);
  const buffer = renderTableToImage(values);
  const imageKey = await uploadImageFromBuffer(APP_ACCESS_TOKEN, buffer);
  const LARK_GROUP_CHAT_IDS_TEST = process.env.LARK_GROUP_CHAT_IDS_TEST?.split(",") || [];
  await sendImageToGroup(APP_ACCESS_TOKEN, LARK_GROUP_CHAT_IDS_TEST, imageKey);
}

// Cron mỗi 2 phút
cron.schedule(
  "*/2 * * * *",
  async () => {
    try {
      const APP_ACCESS_TOKEN = await getAppAccessToken();
      await sendDynamicSheetAsImage(APP_ACCESS_TOKEN);
      console.log("✅ [Cron] Đã gửi hình (B1:H tới dòng cuối cột D)!");
    } catch (err) {
      console.error("❌ [Cron] Lỗi khi gửi ảnh:", err?.response?.data || err.message);
    }
  },
  { scheduled: true, timezone: "Asia/Ho_Chi_Minh" }
);

/* ==================================================
   BOT WOWBUY → Lark Sheet
   Flow: LOGIN -> REFRESH -> GET_TREE -> ENTRY(JSESSIONID) -> INIT -> SUBMIT_FORM -> FETCH -> WRITE
   ================================================== */

app.use(bodyParser.json());

// ========= CONFIG =========
const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const SPREADSHEET_TOKEN_TEST = process.env.SPREADSHEET_TOKEN_TEST;
const SHEET_ID_TEST = process.env.SHEET_ID_TEST;

const WOWBUY_BASEURL = process.env.WOWBUY_BASEURL;
const WOWBUY_USERNAME = process.env.WOWBUY_USERNAME;
const WOWBUY_PASSWORD = process.env.WOWBUY_PASSWORD;

// Chọn báo cáo mong muốn (có thể thay đổi nếu cần báo cáo khác)
const TARGET_REPORT = "Purchase Plan";

let session = {
  token: null,
  cookie: "",
  entryUrl: "",
  sessionid: "",
  lastLogin: 0,
};

// ======= Debug / Cookie helpers =======
function truncate(str = "", len = 40) {
  return str.length > len ? str.slice(0, len) + "..." : str;
}

function maskValue(v) {
  if (!v) return v;
  const s = String(v);
  return s.length <= 24 ? s : s.slice(0, 8) + "..." + s.slice(-6);
}

function maskCookieString(cookieStr = "") {
  return cookieStr
    .split(";")
    .map(p => {
      const pair = p.trim();
      if (!pair) return "";
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const k = pair.slice(0, eq);
      const v = pair.slice(eq + 1);
      if (/fine_auth_token|accessToken|Authorization|auth_token|token|password|fineMarkId|last_login_info/i.test(k)) {
        return `${k}=${maskValue(v)}`;
      }
      return `${k}=${v}`;
    })
    .filter(Boolean)
    .join("; ");
}

function buildCookieHeaderFromSetCookieArray(setCookieArray) {
  if (!setCookieArray) return "";
  return Array.isArray(setCookieArray) ? setCookieArray.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ") : "";
}

function parseSetCookieArrayToObj(setCookieArray) {
  const out = {};
  if (!setCookieArray) return out;
  (Array.isArray(setCookieArray) ? setCookieArray : [setCookieArray]).forEach(c => {
    const first = String(c).split(";")[0].trim();
    const eq = first.indexOf("=");
    if (eq > -1) out[first.slice(0, eq).trim()] = first.slice(eq + 1);
  });
  return out;
}

function cookieStringToObj(cookieStr = "") {
  const out = {};
  if (!cookieStr) return out;
  cookieStr.split(";").map(p => p.trim()).forEach(pair => {
    if (!pair) return;
    const eq = pair.indexOf("=");
    if (eq !== -1) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  });
  return out;
}

function mergeCookieStringWithObj(cookieStr = "", cookieObj = {}) {
  const base = cookieStringToObj(cookieStr);
  Object.keys(cookieObj).forEach(k => base[k] = cookieObj[k]);
  return Object.keys(base).map(k => `${k}=${base[k]}`).join("; ");
}

function extractSessionIDFromHtml(html) {
  const regex = /FR\.SessionMgr\.register\('([^']+)'\)/;
  const match = html.match(regex);
  if (match && match[1]) return match[1];

  const regex2 = /currentSessionID\s*=\s*'([^']+)'/;
  const match2 = html.match(regex2);
  if (match2 && match2[1]) return match2[1];

  return null;
}

async function safeFetchVerbose(url, opts = {}, stepName = "STEP") {
  opts.headers = opts.headers || {};
  const method = (opts.method || "GET").toUpperCase();

  const headersMasked = {};
  Object.keys(opts.headers).forEach(k => {
    const v = opts.headers[k];
    if (/cookie|authorization|set-cookie|token|password/i.test(k)) {
      headersMasked[k] = maskCookieString(String(v));
    } else {
      headersMasked[k] = String(v);
    }
  });

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw err;
  }

  const respHeaders = {};
  res.headers.forEach((v, k) => (respHeaders[k] = v));

  let setCookieArray = [];
  const single = res.headers.get("set-cookie");
  if (single) setCookieArray = [single];

  const respMasked = {};
  Object.keys(respHeaders).forEach(k => {
    const v = respHeaders[k];
    if (/set-cookie|cookie|authorization|token/i.test(k)) {
      respMasked[k] = maskCookieString(String(v));
    } else {
      respMasked[k] = String(v);
    }
  });

  const text = await res.text().catch(() => "");
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) {}

  return { res, status: res.status, headers: respHeaders, setCookieArray, text, json: parsed };
}

async function loginWOWBUY() {
  console.log("🔐 Login WOWBUY...");
  try {
    const url = `${WOWBUY_BASEURL}/webroot/decision/login`;
    const bodyObj = { username: WOWBUY_USERNAME, password: WOWBUY_PASSWORD, validity: -2, sliderToken: "", origin: "", encrypted: true };

    const loginResp = await safeFetchVerbose(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json",
        origin: WOWBUY_BASEURL,
        referer: `${WOWBUY_BASEURL}/webroot/decision/login`,
        "x-requested-with": "XMLHttpRequest",
        "user-agent": "Mozilla/5.0 (Node)",
      },
      body: JSON.stringify(bodyObj),
    }, "LOGIN");

    session.cookie = buildCookieHeaderFromSetCookieArray(loginResp.setCookieArray || "");
    if (loginResp.json?.data?.accessToken) session.token = loginResp.json.data.accessToken;
    else throw new Error("No accessToken in LOGIN response");

    if (session.token) await doTokenRefresh(session.token, session.cookie);

    // Lấy danh sách báo cáo để tìm UUID
    await getReportId();

    if (!session.entryUrl) {
      console.warn("⚠️ entryUrl not set, using default Purchase Plan UUID");
      session.entryUrl = `${WOWBUY_BASEURL}/webroot/decision/v10/entry/access/821488a1-d632-4eb8-80e9-85fae1fb1bda?width=309&height=667`;
    }

    console.log("📥 entryUrl:", session.entryUrl);
    console.log("📡 ENTRY ACCESS to fetch sessionID...");
    const entryResp = await safeFetchVerbose(session.entryUrl, {
      method: "GET",
      headers: {
        cookie: session.cookie,
        authorization: `Bearer ${session.token}`,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
        referer: `${WOWBUY_BASEURL}/webroot/decision`,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      },
    }, "ENTRY_ACCESS");

    if (entryResp.text) {
      const sid = extractSessionIDFromHtml(entryResp.text);
      if (sid) {
        session.sessionid = sid;
        console.log("🆔 sessionID extracted:", session.sessionid);
      } else {
        console.warn("⚠️ Failed to extract sessionID from HTML. Checking HTML:", truncate(entryResp.text, 500));
      }
    } else {
      console.warn("⚠️ No response text available to extract sessionID");
    }

    session.cookie = mergeCookieStringWithObj(session.cookie, parseSetCookieArrayToObj(entryResp.setCookieArray));
    session.lastLogin = Date.now();
    return session;
  } catch (err) {
    console.error("❌ login error:", err.message);
    return null;
  }
}

async function getReportId() {
  console.log("📡 GETTING REPORT TREE...");
  const url = `${WOWBUY_BASEURL}/webroot/decision/v10/view/entry/tree?_= ${Date.now()}`;
  const resp = await safeFetchVerbose(url, {
    method: "GET",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      authorization: `Bearer ${session.token}`,
      cookie: session.cookie,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "x-requested-with": "XMLHttpRequest",
    },
  }, "GET_REPORTS");

  if (resp.json?.data) {
    console.log("📋 Available reports:", resp.json.data.map(item => `'${item.text} (${item.id})'`));
    const report = resp.json.data.find(item => item.text === TARGET_REPORT);
    if (report) {
      session.entryUrl = `${WOWBUY_BASEURL}/webroot/decision/v10/entry/access/${report.id}?width=309&height=667`;
      console.log("📋 Selected entryUrl:", session.entryUrl);
    } else {
      console.warn("⚠️ No report found with text:", TARGET_REPORT);
    }
  } else {
    console.warn("⚠️ No data in report tree response");
  }
}

async function doTokenRefresh(token, cookieHeader) {
  const url = `${WOWBUY_BASEURL}/webroot/decision/token/refresh`;
  const body = { oldToken: token, tokenTimeOut: 1209600000 };

  const refreshResp = await safeFetchVerbose(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      cookie: cookieHeader,
      origin: WOWBUY_BASEURL,
      referer: session.entryUrl,
      "x-requested-with": "XMLHttpRequest",
      "user-agent": "Mozilla/5.0 (Node)",
    },
    body: JSON.stringify(body),
  }, "TOKEN_REFRESH");

  if (refreshResp.json?.data?.accessToken) {
    session.token = refreshResp.json.data.accessToken;
    session.cookie = mergeCookieStringWithObj(session.cookie, parseSetCookieArrayToObj(refreshResp.setCookieArray));
  }
  return true;
}

async function initWOWBUYSession() {
  const steps = [
    { name: "resource", url: `${WOWBUY_BASEURL}/webroot/decision/view/report?op=resource&resource=/com/fr/web/core/js/paramtemplate.js` },
    { name: "fr_paramstpl", url: `${WOWBUY_BASEURL}/webroot/decision/view/report?op=fr_paramstpl&cmd=query_favorite_params`, method: "POST" },
    { name: "fr_dialog", url: `${WOWBUY_BASEURL}/webroot/decision/view/report?op=fr_dialog&cmd=parameters_d`, method: "POST", body: "__parameters__=%7B%22SD%22%3A%222025-08-20%22%2C%22ED%22%3A%222025-09-19%22%7D", headers: { "content-type": "application/x-www-form-urlencoded" } },
    { name: "collect", url: `${WOWBUY_BASEURL}/webroot/decision/preview/info/collect`, method: "POST", body: "webInfo=%7B%22webResolution%22%3A%221536*864%22%2C%22fullScreen%22%3A0%7D", headers: { "content-type": "application/x-www-form-urlencoded" } },
  ];

  for (const step of steps) {
    await safeFetchVerbose(step.url, {
      method: step.method || "GET",
      headers: { authorization: session.token, cookie: session.cookie, ...(step.headers || {}) },
      body: step.body,
    }, `INIT:${step.name}`);
  }
}

async function submitReportForm() {
  console.log("📤 Submitting report form...");
  const formUrl = `${WOWBUY_BASEURL}/webroot/decision/view/report?op=widget&widgetname=formSubmit0&sessionID=${session.sessionid}`;
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
  const endDate = today.toISOString().split('T')[0];
  const formData = {
    SD: startDate,
    ED: endDate,
    SALE_STATUS: "On sale",
    WH: "",
    SKUSN: "",
    KS: "",
    SN: "",
  };

  const resp = await safeFetchVerbose(formUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${session.token}`,
      cookie: session.cookie,
      referer: session.entryUrl,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "x-requested-with": "XMLHttpRequest",
    },
    body: new URLSearchParams(formData).toString(),
  }, "SUBMIT_FORM");

  if (resp.status === 200) {
    console.log("✅ Form submitted successfully");
  } else {
    console.warn("⚠️ Form submit failed with status:", resp.status);
  }
  return resp;
}

async function fetchPageContent() {
  console.log("📡 Fetching page content...");
  const url = `${WOWBUY_BASEURL}/webroot/decision/view/report?op=page_content&pn=1&__webpage__=true&__boxModel__=true&_paperWidth=309&_paperHeight=510&__fit__=false&_=${Date.now()}&sessionID=${session.sessionid}`;
  const resp = await safeFetchVerbose(url, {
    method: "GET",
    headers: {
      accept: "text/html, */*; q=0.01",
      "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.6,en;q=0.5",
      authorization: session.token,
      cookie: session.cookie,
      referer: session.entryUrl,
      "user-agent": "Mozilla/5.0",
      "x-requested-with": "XMLHttpRequest",
    },
  }, "PAGE_CONTENT");

  const raw = resp.text || "";
  let html = raw;
  if (resp.json?.html) html = resp.json.html;

  const $ = cheerio.load(html);
  const rows = [];
  $("table tr").each((i, tr) => {
    const cols = $(tr).find("td,th").map((j, td) => $(td).text().trim()).get();
    if (cols.length > 0) rows.push(cols);
  });
  console.log("📊 Parsed rows:", rows.length);
  if (rows.length > 0) console.log("🔎 First 1 rows:", rows.slice(0, 1));
  return rows;
}

// ======= Main flow =======
async function fetchWOWBUY() {
  try {
    const s = await loginWOWBUY();
    if (!s) {
      console.error("❌ Aborting: login failed");
      return [];
    }
    await initWOWBUYSession();
    const data = await fetchPageContent();

    console.log("📊 Fetched data from WOWBUY:", data?.length || 0, "rows");
    return data;
  } catch (err) {
    console.error("❌ Lỗi trong fetchWOWBUY:", err.message, err.stack);
    return [];
  }
}

/**
 * Lấy tenant access token từ Lark
 */
async function getTenantAccessToken() {
  try {
    const resp = await axios.post(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
      { app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }
    );
    if (resp.data?.tenant_access_token) {
      const token = resp.data.tenant_access_token;
      console.log("🔑 Tenant access token retrieved:", token.slice(0, 10) + "...");
      return token;
    } else {
      throw new Error("Không nhận được tenant access token từ Lark");
    }
  } catch (err) {
    console.error("❌ Lỗi lấy tenant access token:", err.message);
    if (err.response) console.error("📥 Error response:", err.response.data);
    throw err;
  }
}

/**
 * Debug: In ra danh sách các sheet trong file
 */
async function listSheets() {
  const token = await getTenantAccessToken();
  const url = `https://open.larksuite.com/open-apis/sheet/v3/spreadsheets/${SPREADSHEET_TOKEN_TEST}/sheets_query`;

  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  console.log("📋 Available sheets:");
  resp.data.data.sheets.forEach(s => {
    console.log(`- title: ${s.title} | id: ${s.sheet_id}`);
  });
}

// ===== Helper: Convert số cột thành tên cột Excel =====
function columnNumberToName(n) {
  let name = "";
  while (n > 0) {
    let r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/**
 * Ghi dữ liệu vào Lark Sheet
 * tableData: mảng 2 chiều [[col1, col2, ...], [col1, col2, ...], ...]
 */
async function writeToLark(tableData) {
  if (!tableData || tableData.length === 0) {
    console.warn("⚠️ Không có dữ liệu để ghi vào Lark Sheet");
    return;
  }

  try {
    const token = await getTenantAccessToken();

    const rows = tableData.length;
    const cols = tableData[0]?.length || 0;

    // Cột bắt đầu = J (thứ 10), cột kết thúc = J + (cols - 1)
    const startColIndex = 10;
    const endColIndex = startColIndex + cols - 1;
    const endColName = columnNumberToName(endColIndex);

    const range = `${SHEET_ID_TEST}!J1:${endColName}${rows}`;

    const url = `https://open.larksuite.com/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN_TEST}/values_batch_update`;

    const body = {
      valueRanges: [
        {
          range,
          values: tableData,
        },
      ],
    };

    // ==== LOG NGẮN GỌN ====
    console.log("========== DEBUG LARK ==========");
    console.log("🔗 URL:", url);
    console.log("📋 Target range:", range);
    console.log("📊 Data size:", rows, "rows x", cols, "cols");
    console.log("🔑 Token:", token.slice(0, 10) + "...");
    console.log("================================");

    const resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    console.log("📥 Lark response:", JSON.stringify(resp.data, null, 2));

    if (resp.data.code === 0) {
      console.log("✅ Ghi dữ liệu vào Lark Sheet thành công!");
    } else {
      console.warn("⚠️ Lark Sheet API trả lỗi:", resp.data);
    }
  } catch (err) {
    console.error("❌ Lỗi ghi Lark Sheet:", err.message);
    if (err.response) {
      console.error("📥 Error response:", JSON.stringify(err.response.data, null, 2));
    }
  }
}

cron.schedule("*/60 * * * *", async () => {
  try {
    const data = await fetchWOWBUY();
    await writeToLark(data);
  } catch (err) {
    console.error("❌ Job failed:", err.message);
  }
});

app.listen(3000, () => {
  console.log("🚀 Bot running on port 3000");
  fetchWOWBUY();
});

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
   SECTION 14 — Webhook (ONLY on @mention)
   — OPTIMIZED TOKEN + REBATE CMD + RAW BODY FIX
   =========================================== */

app.post('/webhook',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    try {
      const bodyRaw = req.body.toString('utf8');
      const signature = req.headers['x-lark-signature'];
      const timestamp = req.headers['x-lark-request-timestamp'];
      const nonce = req.headers['x-lark-request-nonce'];

      if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
        console.error('[Webhook] ❌ Signature verification failed');
        return res.sendStatus(401);
      }

      let decryptedData = {};
      try {
        decryptedData = decryptMessage(JSON.parse(bodyRaw).encrypt || '');
      } catch (e) {
        console.error('[Webhook] ❌ Decrypt error:', e);
        return res.sendStatus(400);
      }

      // Bot được thêm vào chat
      if (decryptedData.header?.event_type === 'im.chat.member.bot.added_v1') {
        console.log('[Webhook] Bot added to chat → 200');
        return res.sendStatus(200);
      }

      // Nhận tin nhắn
      if (decryptedData.header?.event_type === 'im.message.receive_v1') {
        const message = decryptedData.event.message;
        const messageId = message.message_id;
        const chatId = message.chat_id;
        const chatType = message.chat_type;
        const messageType = message.message_type;
        const senderId = decryptedData.event.sender?.sender_id?.open_id || null;
        const mentions = message.mentions || [];

        // Kiểm tra bot được mention
        const botMentioned = mentions.some(m =>
          (m.id?.open_id && m.id.open_id === BOT_OPEN_ID) ||
          (m.id?.app_id && m.id.app_id === process.env.LARK_APP_ID)
        );

        // Group chat mà không mention bot → bỏ qua không log chi tiết
        if (chatType === 'group' && !botMentioned) {
          return res.sendStatus(200);
        }

        // Từ đây trở xuống mới log chi tiết
        console.log('[Webhook] ▶️ Incoming message', { messageId, chatId, chatType, messageType, senderId });
        console.log('[Webhook] 🔍 Mentions array:', JSON.stringify(mentions, null, 2));

        if (!senderId) {
          console.warn('[Webhook] ⚠ No senderId found in message');
          return res.sendStatus(200);
        }

        if (processedMessageIds.has(messageId)) {
          console.log('[Webhook] 🔁 Duplicate message, ignore', messageId);
          return res.sendStatus(200);
        }
        processedMessageIds.add(messageId);

        // Tránh bot tự trả lời chính mình
        if (senderId === BOT_SENDER_ID) {
          console.log('[Webhook] 🛑 Message from bot itself, ignore');
          return res.sendStatus(200);
        }

        // Trả 200 sớm để tránh timeout
        res.sendStatus(200);

        const token = await getAppAccessToken();

        let mentionUserName = 'Unknown User';
        try {
          const tmpName = await getUserInfo(senderId, token);
          if (tmpName) mentionUserName = tmpName;
        } catch (err) {
          console.error('[Webhook] ❌ getUserInfo error:', err?.response?.data || err.message);
        }
        const mentionUserId = senderId;

        // Parse content
        let messageContent = '';
        try {
          const parsedContent = JSON.parse(message.content);
          messageContent = parsedContent.text || '';
          messageContent = messageContent.replace(/<at.*?<\/at>/g, '').trim();
          console.log('[Webhook] 📝 Text after removing <at> tags:', JSON.stringify(messageContent));
        } catch {
          messageContent = '';
        }

        // Xử lý placeholder bot mention
        let botPlaceholder = '';
        for (const m of mentions) {
          if ((m.id?.open_id && m.id.open_id === BOT_OPEN_ID) ||
              (m.id?.app_id && m.id.app_id === process.env.LARK_APP_ID)) {
            if (m.key) {
              botPlaceholder = m.key;
              console.log('[Webhook] 🔍 Found bot placeholder:', botPlaceholder);
              break;
            }
          }
        }
        if (botPlaceholder) {
          messageContent = messageContent.replace(new RegExp(botPlaceholder, 'gi'), '').trim();
          console.log('[Webhook] 📝 Text after removing bot placeholder:', JSON.stringify(messageContent));
        } else {
          console.warn('[Webhook] ⚠ No bot placeholder found, despite bot mentioned');
        }

        // Thay thế @L-GPT nếu gõ tay
        messageContent = messageContent.replace(/@L-GPT/gi, 'bạn').trim();
        console.log('[Webhook] 📨 Text after full cleanup:', JSON.stringify(messageContent));

      /* ===================== REBATE HANDLER ===================== */
      if (messageType === 'text' && messageContent) {
        const normalized = messageContent.replace(/[.!?…]+$/g, '').trim().toLowerCase();
        const isCheckRebate = /^\s*check\s+rebate\s*$/.test(normalized);
      
        if (isCheckRebate) {
          try {
            const report = await analyzeRebateData(token);
            if (report) {
              // Gửi phản hồi trực tiếp vào group vừa mention BOT
              try {
                await sendMessageToGroup(token, chatId, report);
                console.log('[Rebate] Sent report to group (mention)', chatId);
              } catch (e) {
                console.error('[Rebate] Send to group failed:', chatId, e?.message || e);
                await replyToLark(messageId, `Xin lỗi ${mentionUserName}, tôi không thể gửi báo cáo rebate vào nhóm này.`, mentionUserId, mentionUserName);
              }
            } else {
              await replyToLark(messageId, `Không tìm thấy dữ liệu rebate.`, mentionUserId, mentionUserName);
            }
          } catch (e) {
            console.error('[Rebate] Read error:', e?.message || e);
            await replyToLark(messageId, `Xin lỗi ${mentionUserName}, tôi không thể đọc dữ liệu rebate.`, mentionUserId, mentionUserName);
          }
          return;
        }
      }
      /* =================== END REBATE HANDLER =================== */

         
        /* =================== CHAT AI =================== */
        if (messageType === 'text' && messageContent) {
          try {
            const MAX_HISTORY = 10;
            updateConversationMemory(chatId, 'user', messageContent, mentionUserName);
            let memory = conversationMemory.get(chatId) || [];

            if (memory.length > MAX_HISTORY) {
              const oldPart = memory.slice(0, memory.length - MAX_HISTORY);
              const oldText = oldPart.map(m => `${m.role}: ${m.content}`).join('\n');
              try {
                console.log('[AI] ✂️ Summarizing old context');
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
                console.log('[AI] ✅ Summary updated');
              } catch (e) {
                console.error('[AI] ❌ Summary error:', e.message);
                memory = memory.slice(-MAX_HISTORY);
                conversationMemory.set(chatId, memory);
              }
            }

            const formattedHistory = memory.map(m => ({ role: m.role, content: m.content }));
            const systemPrompt = `Bạn là L-GPT, trợ lý AI thân thiện. 
            Luôn gọi người dùng là "${mentionUserName}", 
            không bao giờ dùng user1, user2... Trả lời ngắn gọn, rõ ràng, tự nhiên.`;

            let assistantMessage = 'Xin lỗi, tôi gặp sự cố khi xử lý yêu cầu của bạn.';
            console.log('[AI] 🚀 Calling model for message:', messageId);

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
              console.log('[AI] ✅ Got response length:', assistantMessage?.length);
              if (assistantMessage.match(/user\d+/i)) {
                assistantMessage = assistantMessage.replace(/user\d+/gi, mentionUserName);
              }
            } catch (err) {
              console.error('[AI] ❌ API error:', err?.response?.data || err.message);
              assistantMessage = `Hiện tại tôi đang gặp sự cố kỹ thuật. ${mentionUserName} vui lòng thử lại sau nhé!`;
            }

            const cleanMessage = assistantMessage.replace(/[\*_\`~]/g, '').trim();
            updateConversationMemory(chatId, 'assistant', cleanMessage, 'L-GPT');
            await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
            console.log('[AI] 📤 Replied to user for message:', messageId);

          } catch (err) {
            console.error('[Webhook] ❌ Text process error:', err);
            await replyToLark(messageId, `Xin lỗi ${mentionUserName}, tôi gặp lỗi khi xử lý tin nhắn của bạn.`, mentionUserId, mentionUserName);
          }
          return;
        }
        /* =================== HẾT CHAT AI =================== */
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('[Webhook] ❌ Global error:', error);
      return res.sendStatus(500);
    }
  }
);

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

// Cron job: chạy mỗi 5 phút (để test)
cron.schedule('0 9 * * 1', async () => {
  console.log('[Rebate] Cron job chạy: 9h sáng Thứ 2');
  try {
    await sendRebateReport();
  } catch (err) {
    console.error('[Rebate] Cron job error:', err);
  }
});
