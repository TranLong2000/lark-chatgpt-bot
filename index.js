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
   SHEETS helper: read sheet range
   =========================== */
async function getSheetData(spreadsheetToken, token, range = 'A:Z') {
  const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`;
  try {
    const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    return resp.data.data.valueRange.values || [];
  } catch {
    return [];
  }
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
      const num = parseFloat(value);
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
   UPDATED: Sale comparison helpers
   =========================== */
async function getSaleComparisonData(token, prevCol, currentCol) {
  try {
    // Các cột cố định + cột động (loại trùng)
    const baseCols = ['A', 'E', 'F', 'G', 'M', 'N', 'O', 'P', 'AK', prevCol, currentCol];
    const cols = Array.from(new Set(baseCols));

    const colData = {};
    for (const col of cols) {
      const url =
        `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/` +
        `${SHEET_ID}!${col}:${col}?valueRenderOption=FormattedValue`;

      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000
      });

      colData[col] = (resp?.data?.data?.valueRange?.values || []).map(r => (r?.[0] ?? ''));
    }

    const lenByE = (colData['E'] || []).length;
    const maxLen = Math.max(...Object.values(colData).map(a => a.length));
    const totalRows = lenByE > 0 ? lenByE : maxLen;

    const getCell = (col, i) =>
      colData[col] && colData[col][i] !== undefined ? colData[col][i] : '';

    const toNumber = (v) => {
      if (v === null || v === undefined) return 0;
      const s = String(v).trim().replace(/,/g, '');
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    };

    const results = [];
    for (let i = 1; i < totalRows; i++) {
      const sku         = getCell('A', i) || '';
      const productName = getCell('E', i) || `Dòng ${i + 1}`;
      const warehouse   = getCell('F', i) || '';
      const stock       = toNumber(getCell('G', i));
      const avr7days    = getCell('M', i) || '';
      const sale3day    = toNumber(getCell('N', i));
      const sale2day    = toNumber(getCell('O', i));
      const sale1day    = toNumber(getCell('P', i));
      const finalStatus = getCell('AK', i) || '';

      const prev    = toNumber(getCell(prevCol, i));
      const current = toNumber(getCell(currentCol, i));

      let change = 0;
      if (prev === 0 && current > 0) change = Infinity;
      else if (prev > 0) change = ((current - prev) / prev) * 100;

      results.push({
        sku,
        productName,
        warehouse,
        stock,
        avr7days,
        sale3day,
        sale2day,
        sale1day,
        finalStatus,
        prev,
        current,
        change
      });
    }

    return results;
  } catch (err) {
    console.log(`Lỗi lấy dữ liệu ${prevCol}/${currentCol}:`, err.message);
    return [];
  }
}

/* ===========================
   UPDATED: analyzeSalesChange (with OOS days)
   =========================== */
async function analyzeSalesChange(token) {
  const now = new Date();
  const nowVN = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  const hourVN = nowVN.getHours();

  const prevCol = "M";
  let currentCol, currentLabel;

  if (hourVN < 12) {
    currentCol = "P";
    currentLabel = "hôm qua";
  } else {
    currentCol = "Q";
    currentLabel = "hôm nay";
  }

  const allData = await getSaleComparisonData(token, prevCol, currentCol);
  if (!allData.length) return null;

  // lọc theo warehouse & có avr7days
  const filteredData = allData.filter(r => 
    r.warehouse === "Binh Tan Warehouse" && r.avr7days
  );
  if (!filteredData.length) {
    return `Không có dữ liệu cho Warehouse: Binh Tan Warehouse`;
  }

  const totalIncrease = filteredData.filter(r => r.change > 0).length;
  const totalDecrease = filteredData.filter(r => r.change < 0).length;

  const increases = filteredData
    .filter(r => r.prev > 0 && r.current > 10 && (r.change >= 0 || r.change === Infinity))
    .sort((a, b) => (b.change === Infinity ? Infinity : b.change) - (a.change === Infinity ? Infinity : a.change))
    .slice(0, 5);

  const decreases = filteredData
    .filter(r => r.prev > 10 && r.change < 0)
    .sort((a, b) => a.change - b.change)
    .slice(0, 5);

  // OOS với số ngày hết hàng theo rule P/O/N
  const allOOS = filteredData
    .filter(r => r.finalStatus.trim() === "On sale" && Number(r.stock) === 0)
    .map(r => {
      let days = 0;
      if (r.sale1day === 0) days = 1;
      if (r.sale1day === 0 && r.sale2day === 0) days = 2;
      if (r.sale1day === 0 && r.sale2day === 0 && r.sale3day === 0) days = 3;

      return {
        ...r,
        daysOOS: days,
        oosLabel: days === 0 ? "" : (days === 3 ? "OOS > 3 ngày" : `OOS ${days} ngày`)
      };
    })
    .filter(r => r.daysOOS > 0)
    .sort((a, b) => b.daysOOS - a.daysOOS);

  const outOfStock = allOOS.slice(0, 5);

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
function updateConversationMemory(chatId, role, content) {
  if (!conversationMemory.has(chatId)) {
    conversationMemory.set(chatId, []);
  }
  const mem = conversationMemory.get(chatId);
  mem.push({ role, content });
  if (mem.length > 10) mem.shift();
}

/* ===========================
   NEW FUNCTION: interpretSheetQuery
   =========================== */
async function interpretSheetQuery(userMessage, columnData) {
  try {
    const prompt = `
Bạn là trợ lý phân tích bảng. Tôi cung cấp:
1) Câu hỏi user: """${userMessage}"""
2) Dữ liệu cột (object): ${JSON.stringify(Object.keys(columnData))}

Hãy CHỈ TRẢ VỀ 1 JSON hợp lệ với các trường:
- action: "value" | "sum" | "avg" | "percent_change" | "count"
- target_column: tên cột (phù hợp với header trong dữ liệu) hoặc tên cột dạng chữ cái nếu ưu tiên
- match_column: tên cột dùng để tìm hàng (ví dụ: "E" hoặc header "Sản phẩm") - optional
- match_value: giá trị để so khớp trong match_column (ví dụ: "Lager") - optional
- prev_column: tên cột dùng để so sánh percent_change - optional
- note: string ngắn mô tả hành động (optional)

Nguyên tắc:
- Nếu câu hỏi rõ ràng hỏi "hôm nay" -> chọn cột tương ứng cho "hôm nay" (ví dụ Q nếu sheet có Q là today).
- Nếu user hỏi "bao nhiêu thùng Lager" -> action="value", match_column có thể là "E" hoặc header tên sản phẩm.
- Trả JSON ngắn, không thêm text khác.
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
      const parsed = JSON.parse(aiContent);
      return parsed;
    } catch (e) {
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
   NEW FUNCTION: interpretSheetQuery
   - AI đọc câu hỏi và chọn cột, hành động
   =========================== */
async function interpretSheetQuery(userMessage, columnData) {
  try {
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
    const sheetData = await getSheetData(spreadsheetToken, token, 'A:Z');
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
      if (!isBotMentioned && !['file','image','text'].includes(messageType)) return res.sendStatus(200);
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

      // ======= XỬ LÝ CHAT AI BÌNH THƯỜNG =========
      if (messageType === 'text' && contentAfterMention.trim()) {
        try {
          updateConversationMemory(chatId, 'user', contentAfterMention);
          const memory = conversationMemory.get(chatId) || [];
          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528:free',
              messages: [...memory.map(({ role, content }) => ({ role, content })), { role: 'user', content: contentAfterMention }],
              stream: false,
            },
            { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
          );
          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, tôi chưa tìm ra được kết quả.';
          const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
          updateConversationMemory(chatId, 'assistant', cleanMessage);
          await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
        } catch {
          await replyToLark(messageId, 'Xin lỗi, tôi chưa tìm ra được kết quả.', mentionUserId, mentionUserName);
        }
        return;
      }

      await replyToLark(messageId, 'Vui lòng sử dụng lệnh Plan, PUR, SALE, FIN kèm dấu phẩy hoặc gửi file/hình ảnh.', mentionUserId, mentionUserName);
    }
  } catch {
    res.status(500).send('Lỗi máy chủ nội bộ');
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
