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

const app = express();
const port = process.env.PORT || 8080;

/* ===========================
   CONFIG MAPPING (BASE / SHEET)
   =========================== */
const BASE_MAPPINGS = {
  'PUR': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbl61rgzOwS8viB2&view=vewi5cxZif',
  'SALE': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tblClioOV3nPN6jM&view=vew7RMyPed',
  'FIN': 'https://cgfscmkep8m.sg.larksuite.com/base/Um8Zb07ayaDFAws9BRFlbZtngZf?table=tblc0IuDKdYrVGqo&view=vewU8BLeBr',
  'TEST': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbllwXLQBdRgex9z&view=vewksBlcon',
  'PAY': 'https://cgfscmkep8m.sg.larksuite.com/base/UBrwbz2tHaeEwosVO5dlV0Lcgqb?table=tblQcpErvmsBpWCh&view=vewIQhfi04'
};

const SHEET_MAPPINGS = {
  'PUR_SHEET': 'https://cgfscmkep8m.sg.larksuite.com/sheets/Qd5JsUX0ehhqO9thXcGlyAIYg9g?sheet=6eGZ0D'
};

/* ===========================
   GLOBAL CONSTANTS
   =========================== */
let lastB2Value = null;
const SPREADSHEET_TOKEN = 'LYYqsXmnPhwwGHtKP00lZ1IWgDb'; // bạn đã đặt trước
const SHEET_ID = '48e2fd';
const GROUP_CHAT_IDS = (process.env.LARK_GROUP_CHAT_IDS || '').split(',').filter(id => id.trim());
const BOT_OPEN_ID = process.env.BOT_OPEN_ID;

/* ===========================
   RUNTIME MAPS
   =========================== */
const processedMessageIds = new Set();
const conversationMemory = new Map();
const pendingTasks = new Map();
const pendingFiles = new Map();

if (!fs.existsSync('temp_files')) {
  fs.mkdirSync('temp_files');
}

/* ===========================
   EXPRESS MIDDLEWARE
   =========================== */
app.use('/webhook', express.raw({ type: '*/*', limit: '10mb', timeout: 60000 }));
app.use('/webhook-base', express.json({ limit: '10mb', timeout: 60000 }));

/* ===========================
   UTIL: Verify / Decrypt
   =========================== */
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

/* ===========================
   HELPERS: Lark user info & reply
   =========================== */
async function getUserInfo(openId, token) {
  try {
    const response = await axios.get(`${process.env.LARK_DOMAIN}/open-apis/contact/v3/users/${openId}?user_id_type=open_id`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return response.data.data.user.name || `User_${openId.slice(-4)}`;
  } catch {
    return `User_${openId.slice(-4)}`;
  }
}

async function replyToLark(messageId, content, mentionUserId = null, mentionUserName = null) {
  try {
    const tokenResp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`, {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    });
    const token = tokenResp.data.app_access_token;

    let messageContent;
    let msgType = 'text';
    if (mentionUserId && mentionUserName && mentionUserId !== BOT_OPEN_ID) {
      messageContent = { text: `${content} <at user_id="${mentionUserId}">${mentionUserName}</at>` };
    } else {
      messageContent = { text: content };
    }

    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages/${messageId}/reply`,
      { msg_type: msgType, content: JSON.stringify(messageContent) },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch {}
}

/* ===========================
   HELPERS: extract file/image content
   =========================== */
async function extractFileContent(fileUrl, fileType) {
  try {
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const buffer = Buffer.from(response.data);

    if (fileType === 'pdf') {
      const data = await pdfParse(buffer);
      return data.text.trim();
    }
    if (fileType === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim();
    }
    if (fileType === 'xlsx') {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
      return sheet.map(row => row.join(', ')).join('; ');
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileType)) {
      const result = await Tesseract.recognize(buffer, 'eng+vie');
      return result.data.text.trim();
    }
    return 'Không hỗ trợ loại file này.';
  } catch {
    return 'Lỗi khi trích xuất nội dung file';
  }
}

async function extractImageContent(imageData) {
  try {
    const result = await Tesseract.recognize(imageData, 'eng+vie');
    return result.data.text.trim();
  } catch {
    return 'Lỗi khi trích xuất nội dung hình ảnh';
  }
}

/* ===========================
   AUTH: Lark app token
   =========================== */
async function getAppAccessToken() {
  try {
    const resp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`, {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }, { timeout: 20000 });
    return resp.data.app_access_token;
  } catch {
    throw new Error('Lỗi lấy token');
  }
}

/* ===========================
   BITABLE helpers (unchanged)
   =========================== */
async function getTableMeta(baseId, tableId, token) {
  try {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/meta`;
    const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    return resp.data.data.fields.map(field => ({
      name: field.name,
      field_id: field.field_id,
    }));
  } catch {
    return [];
  }
}

async function getAllRows(baseId, tableId, token, requiredFields = []) {
  if (global.lastRows && global.lastRows.baseId === baseId && global.lastRows.tableId === tableId) return global.lastRows.rows;

  const rows = [];
  let pageToken = '';
  do {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=20&page_token=${pageToken}`;
    try {
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: requiredFields.length > 0 ? { field_names: requiredFields.join(',') } : {},
        timeout: 30000,
      });
      if (!resp.data || !resp.data.data) break;
      rows.push(...(resp.data.data.items || []));
      pageToken = resp.data.data.page_token || '';
    } catch {
      break;
    }
  } while (pageToken && rows.length < 100);
  global.lastRows = { baseId, tableId, rows };
  return rows;
}

/* ===========================
   SHEETS helper: read sheet range (with retry + formatted values)
   =========================== */
async function getSheetData(spreadsheetToken, token, range = 'A:AK') {
  const base = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`;
  const url = `${base}/${range}${range.includes('?') ? '&' : '?'}valueRenderOption=FormattedValue`;

  const timeout = 60000;   // tăng timeout 60s
  const maxRetries = 2;    // thử lại 2 lần
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout
      });
      return resp?.data?.data?.valueRange?.values || [];
    } catch (err) {
      if (attempt === maxRetries) {
        console.log(`Lỗi getSheetData(${range}):`, err.message);
        return [];
      }
      // chờ ngắn trước khi retry (backoff)
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return [];
}

/* ===========================
   EXISTING: getCellB2Value (unchanged)
   =========================== */
async function getCellB2Value(token) {
  try {
    const targetColumn = 'G';
    const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${SHEET_ID}!${targetColumn}:${targetColumn}`;
    const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    const values = resp.data.data.valueRange.values || [];

    const sum = values.reduce((acc, row) => {
      const value = row[0];
      const num = parseFloat((value ?? '').toString().replace(/,/g, '')); // phòng trường hợp có dấu ,
      return isNaN(num) ? acc : acc + num;
    }, 0);

    return sum || sum === 0 ? sum.toString() : null;
  } catch {
    return null;
  }
}

/* ===========================
   EXISTING: sendMessageToGroup (unchanged)
   =========================== */
async function sendMessageToGroup(token, chatId, messageText) {
  try {
    const payload = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: messageText })
    };
    console.log('Gửi API tới BOT:', { chatId, messageText });
    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.log('Lỗi gửi tin nhắn:', err.message);
  }
}

/* ===========================
   Utils
   =========================== */
function colToIndex(col) {
  // Convert "A"->0, "B"->1, ..., "Z"->25, "AA"->26, ...
  let idx = 0;
  for (let i = 0; i < col.length; i++) {
    idx = idx * 26 + (col.charCodeAt(i) - 64);
  }
  return idx - 1;
}
function toNumber(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/* ===========================
   Function: getSaleComparisonData
   - Đọc một lần A:AK
   - Map theo chỉ số cột (thư mục)
   =========================== */
async function getSaleComparisonData(token, prevCol, currentCol) {
  try {
    const rows = await getSheetData(SPREADSHEET_TOKEN, token, `${SHEET_ID}!A:AK`);
    if (!rows || rows.length <= 1) return [];

    // Chỉ số cột (0-based)
    const col = {
      A: 0,   // SKU (nếu bạn cần)
      E: 4,   // Product Name
      F: 5,   // Warehouse
      G: 6,   // Stock
      M: 12,  // AVR 7 days (text để check khác trống)
      N: 13,  // Sale 3 ngày trước
      O: 14,  // Sale 2 ngày trước
      P: 15,  // Sale hôm qua
      Q: 16,  // Sale hôm nay
      AK: 36  // Final Status
    };

    const prevIdx = colToIndex(prevCol);     // ví dụ "M" -> 12
    const currIdx = colToIndex(currentCol);  // ví dụ "P"/"Q"

    const data = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];

      const productName = r[col.E] ?? `Dòng ${i + 1}`;
      const warehouse   = r[col.F] ?? '';
      const stock       = toNumber(r[col.G]);
      const avr7daysRaw = r[col.M] ?? '';           // chỉ cần khác trống
      const sale3day    = toNumber(r[col.N]);
      const sale2day    = toNumber(r[col.O]);
      const sale1day    = toNumber(r[col.P]);
      const finalStatus = (r[col.AK] ?? '').toString().trim();

      const prev    = toNumber(r[prevIdx]);
      const current = toNumber(r[currIdx]);

      let change = 0;
      if (prev === 0 && current > 0) change = Infinity;
      else if (prev > 0) change = ((current - prev) / prev) * 100;

      data.push({
        productName,
        warehouse,
        finalStatus,
        stock,
        avr7days: avr7daysRaw, // giữ raw để check khác trống
        sale3day,
        sale2day,
        sale1day,
        prev,
        current,
        change
      });
    }

    return data;
  } catch (err) {
    console.error("❌ Error getSaleComparisonData:", err.message);
    return [];
  }
}

/* ===========================
   Function: analyzeSalesChange
   - Tổng SKU tăng/giảm: lọc AK="On sale", F="Binh Tan Warehouse", M≠""
   - TOP 5: lọc F="Binh Tan Warehouse", M≠""
   - OOS: (trên tập totalData + stock=0) theo rule P/O/N
   =========================== */
async function analyzeSalesChange(token) {
  // Giờ VN
  const now = new Date();
  const nowVN = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  const hourVN = nowVN.getHours();

  const prevCol = "M"; // AVG D-7
  let currentCol, currentLabel;
  if (hourVN < 12) {
    currentCol = "P"; // hôm qua
    currentLabel = "hôm qua";
  } else {
    currentCol = "Q"; // hôm nay
    currentLabel = "hôm nay";
  }

  const allData = await getSaleComparisonData(token, prevCol, currentCol);
  if (!allData.length) return "Không lấy được dữ liệu để phân tích.";

  // TOP 5: warehouse + avr7days (khác trống)
  const topData = allData.filter(r =>
    r.warehouse === "Binh Tan Warehouse" && String(r.avr7days).trim() !== ""
  );

  // Tổng SKU: On sale + warehouse + avr7days (khác trống)
  const totalData = allData.filter(r =>
    r.finalStatus === "On sale" &&
    r.warehouse === "Binh Tan Warehouse" &&
    String(r.avr7days).trim() !== ""
  );

  if (!topData.length) {
    return `Không có dữ liệu cho Warehouse: Binh Tan Warehouse`;
  }

  // Tổng SKU tăng/giảm (trên totalData)
  const totalIncrease = totalData.filter(r => r.change > 0).length;
  const totalDecrease = totalData.filter(r => r.change < 0).length;

  // TOP tăng mạnh (trên topData) – giữ nguyên logic lọc
  const increases = topData
    .filter(r => r.prev > 0 && r.current > 10 && (r.change >= 0 || r.change === Infinity))
    .sort((a, b) =>
      (b.change === Infinity ? Number.POSITIVE_INFINITY : b.change) -
      (a.change === Infinity ? Number.POSITIVE_INFINITY : a.change)
    )
    .slice(0, 5);

  // TOP giảm mạnh (trên topData) – giữ nguyên logic lọc
  const decreases = topData
    .filter(r => r.prev > 10 && r.change < 0)
    .sort((a, b) => a.change - b.change)
    .slice(0, 5);

  // OOS (trên totalData) + stock=0 + rule P/O/N
  // Rule:
  // 1) P = 0 -> OOS 1 ngày
  // 2) P = 0, O = 0 -> OOS 2 ngày
  // 3) P = 0, O = 0, N = 0 -> OOS > 3 ngày
  const allOOS = totalData
    .filter(r => Number(r.stock) === 0)
    .map(r => {
      let label = "";
      if (r.sale1day === 0 && r.sale2day === 0 && r.sale3day === 0) {
        label = "OOS > 3 ngày";
      } else if (r.sale1day === 0 && r.sale2day === 0) {
        label = "OOS 2 ngày";
      } else if (r.sale1day === 0) {
        label = "OOS 1 ngày";
      }
      return { ...r, oosLabel: label };
    })
    .filter(r => r.oosLabel) // chỉ giữ các SKU có nhãn OOS
    .sort((a, b) => {
      const w = (lbl) => lbl.includes("> 3") ? 3 : lbl.includes("2") ? 2 : 1;
      return w(b.oosLabel) - w(a.oosLabel);
    });

  const outOfStock = allOOS.slice(0, 5);

  // Build message
  let msg = `📊 Biến động Sale (WBT): AVG D-7 → ${currentLabel}:\n`;

  if (increases.length) {
    msg += `\n🔥 Top 5 HOT SKU tăng mạnh/ Tổng ${totalIncrease} SKU tăng:\n`;
    increases.forEach(r => {
      const pct = r.change === Infinity ? "+∞%" : `+${r.change.toFixed(1)}%`;
      msg += `- ${r.productName}: ${r.prev} → ${r.current} (${pct})\n`;
    });
  }

  if (decreases.length) {
    msg += `\n📉 Top 5 HOT SKU giảm mạnh/ Tổng ${totalDecrease} SKU giảm:\n`;
    decreases.forEach(r => {
      msg += `- ${r.productName}: ${r.prev} → ${r.current} (${r.change.toFixed(1)}%)\n`;
    });
  }

  if (outOfStock.length) {
    msg += `\n🚨 SKU hết hàng/ Tổng ${allOOS.length} SKU OOS:\n`;
    outOfStock.forEach(r => {
      msg += `- ${r.productName} (${r.oosLabel})\n`;
    });
    if (allOOS.length > 5) {
      msg += `... và ${allOOS.length - 5} SKU khác.\n`;
    }
  }

  return msg;
}

/* ===========================
   EXISTING: checkB2ValueChange
   =========================== */
async function checkB2ValueChange() {
  try {
    const token = await getAppAccessToken();
    const currentB2Value = await getCellB2Value(token);

    console.log('Đã đổ số:', { current: currentB2Value, last: lastB2Value });

    if (currentB2Value !== null && currentB2Value !== lastB2Value && lastB2Value !== null) {
      let messageText = `✅ Đã đổ Stock. Số lượng: ${currentB2Value} thùng`;

      // Gửi tin nhắn "Đã đổ Stock"
      for (const chatId of GROUP_CHAT_IDS) {
        await sendMessageToGroup(token, chatId, messageText);
      }

      // Gọi phân tích tăng/giảm ngay sau
      const salesMsg = await analyzeSalesChange(token);
      if (salesMsg) {
        for (const chatId of GROUP_CHAT_IDS) {
          await sendMessageToGroup(token, chatId, salesMsg);
        }
      }
    }

    lastB2Value = currentB2Value;
  } catch (err) {
    console.log('Lỗi checkB2ValueChange:', err.message);
  }
}

/* ===========================
   Conversation memory helper
   =========================== */
function updateConversationMemory(chatId, role, content, senderName = null) {
  if (!conversationMemory.has(chatId)) {
    conversationMemory.set(chatId, []);
  }
  const mem = conversationMemory.get(chatId);
  mem.push({ role, content, senderName });
  if (mem.length > 20) mem.shift(); // giữ tối đa 20 câu
}

/* ===========================
   Check Remaining Credits
   =========================== */
async function checkRemainingCredits() {
  try {
    const response = await axios.get('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
    });
    const { usage, limit } = response.data.data;
    const remaining = limit ? limit - usage : 'Unlimited';
    console.log(`Remaining credits: ${remaining}`);
  } catch (err) {
    console.log('Error checking credits:', err.message);
  }
}

/* ===========================
   NEW FUNCTION: interpretSheetQuery
   - AI đọc câu hỏi và chọn cột, hành động
   =========================== */
async function interpretSheetQuery(userMessage, columnData) {
  try {
    await checkRemainingCredits();
    const prompt = `
Bạn là trợ lý phân tích bảng. Tôi cung cấp:
1) Câu hỏi user: """${userMessage}"""
2) Dữ liệu cột (object): ${JSON.stringify(Object.keys(columnData))}

Hãy CHỈ TRẢ VỀ 1 JSON hợp lệ với các trường:
- action: "value" | "sum" | "avg" | "percent_change" | "count"
- target_column: tên cột (phù hợp với header trong dữ liệu) hoặc tên cột dạng chữ cái nếu ưu tiên
- match_column: tên cột dùng để tìm hàng - optional
- match_value: giá trị để so khớp trong match_column - optional
- note: string ngắn mô tả hành động (optional)

Trả JSON ngắn, không thêm text khác.
`;

    const aiResp = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-r1-0528:free',
        messages: [
          { role: 'system', content: 'Bạn là một trợ lý AI chuyên phân tích column headers và chọn cột phù hợp.' },
          { role: 'user', content: prompt }
        ],
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const aiContent = aiResp.data?.choices?.[0]?.message?.content?.trim();
    if (!aiContent) return null;

    try {
      return JSON.parse(aiContent);
    } catch {
      const match = aiContent.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { return null; }
      }
      return null;
    }
  } catch (err) {
    console.log('Lỗi interpretSheetQuery:', err.message);
    return null;
  }
}

/* ===========================
   NEW FUNCTION: processPlanQuery
   - Truy xuất Sheet, dùng AI phân tích, trả kết quả
   =========================== */
async function processPlanQuery(messageId, spreadsheetToken, userMessage, token, mentionUserId, mentionUserName) {
  try {
    const sheetData = await getSheetData(spreadsheetToken, token, 'A:AL');
    if (!sheetData || sheetData.length === 0) {
      await replyToLark(messageId, 'Không tìm thấy dữ liệu trên sheet.', mentionUserId, mentionUserName);
      return;
    }

    const headers = sheetData[0].map(h => (h ? h.toString().trim() : ''));
    const rows = sheetData.slice(1).map(r => r.map(c => (c === undefined || c === null) ? '' : c.toString().trim()));

    const headerToIndex = {};
    headers.forEach((h, i) => { headerToIndex[h] = i; });

    const columnData = {};
    headers.forEach((h, idx) => { columnData[h || `Column_${idx}`] = rows.map(r => r[idx] || ''); });

    const interpretation = await interpretSheetQuery(userMessage, columnData);
    if (!interpretation || !interpretation.action || !interpretation.target_column) {
      await replyToLark(messageId, 'Không hiểu yêu cầu từ câu hỏi. Ví dụ: "Plan, hôm nay bán bao nhiêu thùng Lager".', mentionUserId, mentionUserName);
      return;
    }

    // Xác định cột
    const tcol = interpretation.target_column;
    let targetColIdx = /^[A-Z]$/.test(tcol) ? tcol.charCodeAt(0) - 'A'.charCodeAt(0) : headerToIndex[tcol];
    const mcol = interpretation.match_column;
    let matchColIdx = mcol ? (/^[A-Z]$/.test(mcol) ? mcol.charCodeAt(0) - 'A'.charCodeAt(0) : headerToIndex[mcol]) : null;

    const matchValue = interpretation.match_value;
    const action = interpretation.action;

    let resultText = '';
    const parseNum = v => {
      if (v === '' || v === null || v === undefined) return NaN;
      const cleaned = v.toString().replace(/[^\d\.\-]/g, '');
      const n = parseFloat(cleaned);
      return isNaN(n) ? NaN : n;
    };

    if (action === 'value') {
      if (matchColIdx === null || matchValue === undefined) resultText = 'Thiếu thông tin để tìm hàng.';
      else if (targetColIdx === null) resultText = 'Không xác định được cột dữ liệu.';
      else {
        const foundRow = rows.find(r => (r[matchColIdx] || '').toString().toLowerCase().includes(matchValue.toString().toLowerCase()));
        resultText = foundRow ? `Kết quả: ${headers[matchColIdx]}="${foundRow[matchColIdx]}" → ${headers[targetColIdx]} = ${foundRow[targetColIdx]}` : `Không tìm thấy hàng khớp "${matchValue}"`;
      }
    } else if (['sum','avg','count'].includes(action)) {
      if (targetColIdx === null) resultText = 'Không xác định được cột để tính toán.';
      else {
        let filteredRows = rows;
        if (matchColIdx !== null && matchValue !== undefined) {
          filteredRows = rows.filter(r => (r[matchColIdx] || '').toString().toLowerCase().includes(matchValue.toString().toLowerCase()));
        }
        const nums = filteredRows.map(r => parseNum(r[targetColIdx])).filter(n => !isNaN(n));
        if (nums.length === 0) resultText = 'Không có giá trị số để tính toán.';
        else {
          if (action === 'sum') resultText = `Tổng (${headers[targetColIdx]}): ${nums.reduce((a,b)=>a+b,0)}`;
          else if (action === 'avg') resultText = `Trung bình (${headers[targetColIdx]}): ${(nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(2)}`;
          else if (action === 'count') resultText = `Số dòng thỏa: ${nums.length}`;
        }
      }
    } else resultText = 'Action không được hỗ trợ: ' + action;

    await replyToLark(messageId, resultText, mentionUserId, mentionUserName);

  } catch (err) {
    console.log('Lỗi processPlanQuery:', err.message);
    await replyToLark(messageId, 'Lỗi khi xử lý Plan query. Vui lòng thử lại sau.', mentionUserId, mentionUserName);
  } finally {
    pendingTasks.delete(messageId);
  }
}

/* ===========================
   WEBHOOK MAIN
   - Kết hợp Plan + chat AI + Base + file
   =========================== */
app.post('/webhook', async (req, res) => {
  try {
    const bodyRaw = req.body.toString('utf8');
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) return res.sendStatus(401);

    let decryptedData = {};
    try { decryptedData = decryptMessage(JSON.parse(bodyRaw).encrypt || ''); } catch {}

    if (decryptedData.header?.event_type === 'url_verification') return res.json({ challenge: decryptedData.event.challenge });

    if (decryptedData.header?.event_type === 'im.message.receive_v1') {
      const senderId = decryptedData.event.sender.sender_id.open_id;
      const message = decryptedData.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const chatType = message.chat_type;
      const messageType = message.message_type;
      const mentions = message.mentions || [];

      if (chatType === 'group') console.log(`BOT đang trò chuyện trong Group Chat ID: ${chatId}`);

      if (processedMessageIds.has(messageId)) return res.sendStatus(200);
      processedMessageIds.add(messageId);

      if (senderId === (process.env.BOT_SENDER_ID || '')) return res.sendStatus(200);

      const isBotMentioned = mentions.some(m => m.id.open_id === BOT_OPEN_ID);
      if (!isBotMentioned) return res.sendStatus(200);
      res.sendStatus(200);

      const token = await getAppAccessToken();
      let mentionUserId = senderId;
      let mentionUserName = await getUserInfo(senderId, token);

      if (mentions.length > 0) {
        const userMention = mentions.find(m => m.id.open_id !== BOT_OPEN_ID && m.id.open_id !== senderId);
        if (userMention) {
          mentionUserId = userMention.id.open_id;
          mentionUserName = await getUserInfo(mentionUserId, token);
        }
      }

      let contentAfterMention = '';
      try { contentAfterMention = JSON.parse(message.content).text.replace(/^@.*?\s*/, '').trim(); } catch {}

      // ======= XỬ LÝ PLAN =========
      if (/^Plan[,，]/i.test(contentAfterMention)) {
        pendingTasks.set(messageId, { chatId, userMessage: contentAfterMention, mentionUserId, mentionUserName });
        await processPlanQuery(messageId, SPREADSHEET_TOKEN, contentAfterMention, token, mentionUserId, mentionUserName);
        return;
      }

      // ======= XỬ LÝ BASE =========
      let baseId = '';
      let tableId = '';
      const reportMatch = contentAfterMention.match(new RegExp(`^(${Object.keys(BASE_MAPPINGS).join('|')})(,|,)`, 'i'));
      if (reportMatch) {
        const reportName = reportMatch[1].toUpperCase();
        const reportUrl = BASE_MAPPINGS[reportName];
        if (reportUrl) {
          const urlMatch = reportUrl.match(/base\/([a-zA-Z0-9]+)\?.*table=([a-zA-Z0-9]+)/);
          if (urlMatch) {
            baseId = urlMatch[1];
            tableId = urlMatch[2];
          }
        }
      }
      if (baseId && tableId) {
        pendingTasks.set(messageId, { chatId, userMessage: contentAfterMention, mentionUserId, mentionUserName });
        await processBaseData(messageId, baseId, tableId, contentAfterMention, token);
        return;
      }

      // ======= XỬ LÝ FILE / IMAGE =========
      if (['file','image'].includes(messageType)) {
        try {
          const fileKey = message.file_key;
          if (!fileKey) {
            await replyToLark(messageId, 'Không tìm thấy file_key. Vui lòng kiểm tra lại.', mentionUserId, mentionUserName);
            return;
          }

          const fileName = message.file_name || `${messageId}.${messageType === 'image' ? 'jpg' : 'bin'}`;
          const ext = path.extname(fileName).slice(1).toLowerCase();

          pendingFiles.set(chatId, { fileKey, fileName, ext, messageId, timestamp: Date.now() });

          await replyToLark(
            messageId,
            'File đã nhận. Vui lòng reply với câu hỏi hoặc yêu cầu (tag @BOT nếu cần). File sẽ bị xóa sau 5 phút nếu không reply.',
            mentionUserId,
            mentionUserName
          );
        } catch (err) {
          await replyToLark(messageId, `Lỗi khi xử lý file ${message.file_name || 'không xác định'}.`, mentionUserId, mentionUserName);
        }
        return;
      }

      // ======= XỬ LÝ REPLY FILE =========
      if (messageType === 'post' && message.parent_id) {
        const pendingFile = pendingFiles.get(chatId);
        if (pendingFile && pendingFile.messageId === message.parent_id) {
          try {
            const fileUrlResp = await axios.get(
              `${process.env.LARK_DOMAIN}/open-apis/im/v1/files/${pendingFile.fileKey}/download_url`,
              { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
            );
            const fileUrl = fileUrlResp.data.data.download_url;
            const extractedText = await extractFileContent(fileUrl, pendingFile.ext);
            if (!extractedText || extractedText.startsWith('Lỗi')) {
              await replyToLark(messageId, `Không thể trích xuất nội dung từ file ${pendingFile.fileName}.`, mentionUserId, mentionUserName);
            } else {
              const combinedMessage = contentAfterMention + `\nNội dung từ file: ${extractedText}`;
              updateConversationMemory(chatId, 'user', combinedMessage);
              const memory = conversationMemory.get(chatId) || [];
              await checkRemainingCredits();
              const aiResp = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                  model: 'deepseek/deepseek-r1-0528:free',
                  messages: [...memory.map(({ role, content }) => ({ role, content })), { role: 'user', content: combinedMessage }],
                  stream: false,
                },
                { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
              );
              const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, chưa tìm ra kết quả.';
              const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
              updateConversationMemory(chatId, 'assistant', cleanMessage);
              await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
            }
            pendingFiles.delete(chatId);
          } catch {
            await replyToLark(messageId, `Lỗi khi xử lý file ${pendingFile.fileName}.`, mentionUserId, mentionUserName);
            pendingFiles.delete(chatId);
          }
        } else {
          await replyToLark(messageId, 'Vui lòng reply trực tiếp tin nhắn chứa file để xử lý.', mentionUserId, mentionUserName);
        }
        return;
      }

      // ======= XỬ LÝ CHAT AI =========
      if (messageType === 'text') {
        // Lấy danh sách mentions trong message
        const mentions = message.mentions || [];

        // Kiểm tra bot có bị mention không
        const botMentioned = mentions.some(m => m.id.open_id === BOT_OPEN_ID);

        // Nếu không mention bot thì bỏ qua
        if (!botMentioned) {
          return;
        }

        // Cắt bỏ phần @mention bot khỏi nội dung
        const text = JSON.parse(message.content).text || '';
        const contentAfterMention = text.replace(/<at.*?<\/at>/g, '').trim();

        if (!contentAfterMention) {
          return;
        }

        try {
          // Lưu hội thoại kèm tên người gửi
          updateConversationMemory(chatId, 'user', contentAfterMention, mentionUserName);

          const memory = conversationMemory.get(chatId) || [];

          // Biến đổi memory thành prompt với tên người gửi
          const formattedHistory = memory.map(m => {
            if (m.role === 'user') {
              return { role: 'user', content: `${m.senderName || 'User'}: ${m.content}` };
            } else {
              return { role: 'assistant', content: `L-GPT: ${m.content}` };
            }
          });

          await checkRemainingCredits();
          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528:free',
              messages: [
                { role: 'system', content: 'Bạn là một trợ lý AI lạnh lùng, trả lời ngắn gọn, súc tích, luôn xưng danh là L-GPT.' },
                ...formattedHistory,
                { role: 'user', content: `${mentionUserName}: ${contentAfterMention}` }
              ],
              stream: false,
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
              },
              timeout: 20000,
            }
          );

          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, tôi chưa tìm ra được kết quả.';
          const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();

          // Lưu phản hồi bot với tên L-GPT
          updateConversationMemory(chatId, 'assistant', cleanMessage, 'L-GPT');

          await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
        } catch (err) {
          await replyToLark(messageId, 'Xin lỗi, tôi chưa tìm ra được kết quả.', mentionUserId, mentionUserName);
        }

        return;
      }
    }
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

/* ===========================
   SHUTDOWN HANDLER
   =========================== */
process.on('SIGTERM', () => {
  pendingTasks.forEach((task, messageId) => replyToLark(messageId, 'Xử lý bị gián đoạn.', task.mentionUserId, task.mentionUserName));
  process.exit(0);
});

/* ===========================
   MEMORY CLEAR INTERVAL
   =========================== */
setInterval(() => {
  conversationMemory.clear();
}, 2 * 60 * 60 * 1000);

/* ===========================
   START SERVER
   =========================== */
app.listen(port, () => {
  checkB2ValueChange();
  setInterval(checkB2ValueChange, 1 * 60 * 1000);
});

/* ===========================
   CLEANUP PENDING FILES
   =========================== */
setInterval(() => {
  const now = Date.now();
  for (const [chatId, file] of pendingFiles) {
    if (now - file.timestamp > 5 * 60 * 1000) pendingFiles.delete(chatId);
  }
}, 60 * 1000);
