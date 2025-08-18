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
const BOT_OPEN_ID = 'ou_28e2a5e298050b5f08899314b2d49300';

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
    const cols = ['E', prevCol, currentCol];
    let data = {};

    for (const col of cols) {
      const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${SHEET_ID}!${col}:${col}`;
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000
      });
      data[col] = resp.data.data.valueRange.values.map(r => r[0]);
    }

    let results = [];
    for (let i = 1; i < data['E'].length; i++) {
      const productName = data['E'][i] || `Dòng ${i+1}`;
      const prev = parseFloat(data[prevCol][i]) || 0;
      const current = parseFloat(data[currentCol][i]) || 0;

      // bỏ các dòng prev=0 và current=0
      if (prev === 0 && current === 0) continue;

      const change = prev === 0 ? (current > 0 ? Infinity : 0) : ((current - prev) / prev) * 100;
      results.push({ productName, prev, current, change });
    }

    return results;
  } catch (err) {
    console.log(`Lỗi lấy dữ liệu ${prevCol}/${currentCol}:`, err.message);
    return [];
  }
}

/* ===========================
   UPDATED: analyzeSalesChange
   =========================== */
async function analyzeSalesChange(token) {
  // Lấy giờ hiện tại theo múi giờ Việt Nam
  const now = new Date();
  const nowVN = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  const hourVN = nowVN.getHours();

  const prevCol = "M"; // AVG sale 7 ngày trước
  let currentCol, currentLabel;

  if (hourVN < 12) {
    currentCol = "P";
    currentLabel = "hôm qua";
  } else {
    currentCol = "Q";
    currentLabel = "hôm nay";
  }

  // Lấy toàn bộ dữ liệu
  const allData = await getSaleComparisonData(token, prevCol, currentCol);
  if (!allData.length) return null;

  // Tổng số mã tăng/giảm trên toàn bộ dữ liệu
  const totalIncrease = allData.filter(r => r.change > 0).length;
  const totalDecrease = allData.filter(r => r.change < 0).length;

  // Top 5 tăng mạnh: prev > 0 && current > 10
  const increases = allData
    .filter(r => r.prev > 0 && r.current > 10 && (r.change >= 0 || r.change === Infinity))
    .sort((a, b) => (b.change === Infinity ? Infinity : b.change) - (a.change === Infinity ? Infinity : a.change))
    .slice(0, 5);

  // Top 5 giảm mạnh: prev > 10 && change < 0
  const decreases = allData
    .filter(r => r.prev > 10 && r.change < 0)
    .sort((a, b) => a.change - b.change)
    .slice(0, 5);

  // Tạo tin nhắn
  let msg = `📊 Biến động Sale: AVG 7 ngày trước → ${currentLabel}:\n`;

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
   NEW FUNCTION: processPlanQuery
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
    const headerToColLetter = {};
    for (let i = 0; i < headers.length; i++) {
      const letter = String.fromCharCode('A'.charCodeAt(0) + i);
      headerToIndex[headers[i]] = i;
      headerToColLetter[headers[i]] = letter;
    }

    const columnData = {};
    headers.forEach((h, idx) => {
      columnData[h || `Column_${idx}`] = rows.map(r => r[idx] || '');
    });

    const interpretation = await interpretSheetQuery(userMessage, columnData);
    if (!interpretation || !interpretation.action || !interpretation.target_column) {
      await replyToLark(messageId, 'Không thể hiểu yêu cầu từ câu hỏi. Vui lòng thử hỏi đơn giản hơn (ví dụ: "Plan, hôm nay bán bao nhiêu thùng Lager").', mentionUserId, mentionUserName);
      return;
    }

    let targetColIdx = null;
    const tcol = interpretation.target_column;
    if (/^[A-Z]$/.test(tcol)) targetColIdx = tcol.charCodeAt(0) - 'A'.charCodeAt(0);
    else if (headerToIndex.hasOwnProperty(tcol)) targetColIdx = headerToIndex[tcol];
    else {
      const foundHeader = headers.find(h => h && h.toLowerCase().includes((tcol || '').toLowerCase()));
      if (foundHeader) targetColIdx = headerToIndex[foundHeader];
    }

    let matchColIdx = null;
    if (interpretation.match_column) {
      const mcol = interpretation.match_column;
      if (/^[A-Z]$/.test(mcol)) matchColIdx = mcol.charCodeAt(0) - 'A'.charCodeAt(0);
      else if (headerToIndex.hasOwnProperty(mcol)) matchColIdx = headerToIndex[mcol];
      else {
        const foundHeader = headers.find(h => h && h.toLowerCase().includes((mcol || '').toLowerCase()));
        if (foundHeader) matchColIdx = headerToIndex[foundHeader];
      }
    }

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
      if (matchColIdx === null || matchValue === undefined) resultText = 'Thiếu thông tin để tìm hàng (match column hoặc match value).';
      else if (targetColIdx === null) resultText = 'Không xác định được cột dữ liệu cần lấy.';
      else {
        let found = false;
        for (let r = 0; r < rows.length; r++) {
          const cell = (rows[r][matchColIdx] || '').toString().trim();
          if (cell && matchValue && cell.toLowerCase().includes(matchValue.toString().toLowerCase())) {
            const targetCell = rows[r][targetColIdx] || '';
            resultText = `Kết quả: ${headers[matchColIdx] || 'match'}="${cell}" → ${headers[targetColIdx] || 'target'} = ${targetCell}`;
            found = true;
            break;
          }
        }
        if (!found) resultText = `Không tìm thấy hàng khớp "${matchValue}" trong cột ${headers[matchColIdx] || matchColIdx}.`;
      }
    } else if (action === 'sum' || action === 'avg' || action === 'count') {
      if (targetColIdx === null) resultText = 'Không xác định được cột để tính tổng.';
      else {
        let filteredRows = rows;
        if (matchColIdx !== null && matchValue !== undefined) {
          filteredRows = rows.filter(r => (r[matchColIdx] || '').toString().toLowerCase().includes(matchValue.toString().toLowerCase()));
        }
        const nums = filteredRows.map(r => parseNum(r[targetColIdx])).filter(n => !isNaN(n));
        if (nums.length === 0) resultText = 'Không có giá trị số để tính toán.';
        else {
          if (action === 'sum') resultText = `Tổng (${headers[targetColIdx] || 'target'}): ${nums.reduce((a,b)=>a+b,0)}`;
          else if (action === 'avg') resultText = `Trung bình (${headers[targetColIdx] || 'target'}): ${(nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(2)}`;
          else if (action === 'count') resultText = `Số dòng thỏa: ${nums.length}`;
        }
      }
    } else if (action === 'percent_change') {
      const prevCol = interpretation.prev_column;
      let prevIdx = null;
      if (prevCol) {
        if (/^[A-Z]$/.test(prevCol)) prevIdx = prevCol.charCodeAt(0) - 'A'.charCodeAt(0);
        else if (headerToIndex.hasOwnProperty(prevCol)) prevIdx = headerToIndex[prevCol];
        else {
          const fh = headers.find(h => h && h.toLowerCase().includes((prevCol || '').toLowerCase()));
          if (fh) prevIdx = headerToIndex[fh];
        }
      }
      if (prevIdx === null || targetColIdx === null || matchColIdx === null || !matchValue) {
        resultText = 'Thiếu thông tin để tính percent_change (cần prev column, target column, match column/value).';
      } else {
        let found = false;
        for (let r = 0; r < rows.length; r++) {
          const cell = (rows[r][matchColIdx] || '').toString().trim();
          if (cell && matchValue && cell.toLowerCase().includes(matchValue.toString().toLowerCase())) {
            const prevVal = parseNum(rows[r][prevIdx]);
            const curVal = parseNum(rows[r][targetColIdx]);
            if (isNaN(prevVal) || isNaN(curVal)) resultText = 'Các giá trị không phải số, không thể tính phần trăm.';
            else {
              const change = prevVal === 0 ? (curVal > 0 ? Infinity : 0) : ((curVal - prevVal) / prevVal) * 100;
              const pct = change === Infinity ? '∞' : `${change.toFixed(1)}%`;
              resultText = `${matchValue}: ${prevVal} → ${curVal} (Thay đổi: ${pct})`;
            }
            found = true;
            break;
          }
        }
        if (!found) resultText = `Không tìm thấy hàng khớp "${matchValue}" trong cột ${headers[matchColIdx] || matchColIdx}.`;
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
   EXISTING: analyzeQueryAndProcessData (unchanged)
   - xử lý cho base (bitable)
   =========================== */
async function analyzeQueryAndProcessData(userMessage, baseId, tableId, token) {
  try {
    const fields = await getTableMeta(baseId, tableId, token);
    const fieldNames = fields.length > 0 ? fields.map(f => f.name) : [];
    const rows = await getAllRows(baseId, tableId, token);
    const allRows = rows.map(row => row.fields || {});

    if (!allRows || allRows.length === 0) return { result: 'Không có dữ liệu trong Base' };
    const validRows = allRows.filter(row => row && typeof row === 'object');
    if (validRows.length === 0) return { result: 'Không có hàng hợp lệ' };

    const headerRow = validRows[0];
    const columnMapping = {};
    if (headerRow) {
      Object.keys(headerRow).forEach((fieldId, index) => {
        columnMapping[fieldId] = fieldNames[index] || fieldId;
      });
    }

    const columnData = {};
    Object.keys(columnMapping).forEach(fieldId => {
      columnData[columnMapping[fieldId]] = validRows.map(row => row[fieldId] ? row[fieldId].toString().trim() : null);
    });

    const analysisPrompt = `
      Bạn là một trợ lý AI chuyên phân tích dữ liệu bảng. Dựa trên câu hỏi sau và dữ liệu cột dưới đây:
      - Câu hỏi: "${userMessage}"
      - Dữ liệu cột: ${JSON.stringify(columnData)}
      Hãy:
      1. Xác định cột liên quan và giá trị cần tính toán hoặc lọc.
      2. Lọc hoặc tính toán dựa trên yêu cầu (tổng, trung bình, lọc theo điều kiện, v.v.).
      3. Trả lời dưới dạng JSON: { "result": string } với kết quả tính toán hoặc thông báo nếu không có dữ liệu.
      Nếu không rõ, trả về: { "result": "Không hiểu yêu cầu, vui lòng kiểm tra lại cú pháp" }.
    `;

    const aiResponse = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-r1-0528:free',
        messages: [
          { role: 'system', content: 'Bạn là một trợ lý AI chuyên phân tích dữ liệu bảng với ít token nhất. Luôn trả lời dưới dạng JSON hợp lệ.' },
          { role: 'user', content: analysisPrompt },
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

    const aiContent = aiResponse.data.choices[0].message.content.trim();
    try {
      return JSON.parse(aiContent);
    } catch {
      return { result: 'Lỗi khi phân tích câu hỏi, vui lòng kiểm tra lại cú pháp' };
    }
  } catch {
    return { result: 'Lỗi khi xử lý, vui lòng liên hệ Admin Long' };
  }
}

/* ===========================
   EXISTING: processBaseData (unchanged)
   - handle bitable response
   =========================== */
async function processBaseData(messageId, baseId, tableId, userMessage, token) {
  try {
    const { result } = await analyzeQueryAndProcessData(userMessage, baseId, tableId, token);
    const chatId = pendingTasks.get(messageId)?.chatId;
    updateConversationMemory(chatId, 'user', userMessage);
    updateConversationMemory(chatId, 'assistant', result);
    await replyToLark(messageId, result, pendingTasks.get(messageId)?.mentionUserId, pendingTasks.get(messageId)?.mentionUserName);
  } catch {
    await replyToLark(
      messageId,
      'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long',
      pendingTasks.get(messageId)?.mentionUserId,
      pendingTasks.get(messageId)?.mentionUserName
    );
  } finally {
    pendingTasks.delete(messageId);
  }
}

/* ===========================
   EXISTING: processSheetData (unchanged)
   - Generic sheet query via AI
   =========================== */
async function processSheetData(messageId, spreadsheetToken, userMessage, token, mentionUserId, mentionUserName) {
  try {
    const sheetData = await getSheetData(spreadsheetToken, token);
    if (!sheetData || sheetData.length === 0) {
      await replyToLark(messageId, 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long', mentionUserId, mentionUserName);
      return;
    }

    const chatId = pendingTasks.get(messageId)?.chatId;
    const headers = sheetData[0] || [];
    const rows = sheetData.slice(1).map(row => row.map(cell => cell || ''));

    const columnData = {};
    headers.forEach((header, index) => {
      if (header) columnData[header] = rows.map(row => row[index] || null);
    });

    const analysisPrompt = `
      Bạn là một trợ lý AI chuyên phân tích dữ liệu bảng. Dựa trên câu hỏi sau và dữ liệu cột dưới đây:
      - Câu hỏi: "${userMessage}"
      - Dữ liệu cột: ${JSON.stringify(columnData)}
      Hãy:
      1. Xác định cột liên quan và giá trị cần tính toán hoặc lọc.
      2. Lọc hoặc tính toán dựa trên yêu cầu (tổng, trung bình, lọc theo điều kiện, v.v.).
      3. Trả lời dưới dạng JSON: { "result": string } với kết quả tính toán hoặc thông báo nếu không có dữ liệu.
      Nếu không rõ, trả về: { "result": "Không hiểu yêu cầu, vui lòng kiểm tra lại cú pháp" }.
    `;

    const aiResponse = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-r1-0528:free',
        messages: [
          { role: 'system', content: 'Bạn là một trợ lý AI chuyên phân tích dữ liệu bảng với ít token nhất. Luôn trả lời dưới dạng JSON hợp lệ.' },
          { role: 'user', content: analysisPrompt },
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

    const aiContent = aiResponse.data.choices[0].message.content.trim();
    try {
      const analysis = JSON.parse(aiContent);
      updateConversationMemory(chatId, 'user', userMessage);
      updateConversationMemory(chatId, 'assistant', analysis.result);
      await replyToLark(messageId, analysis.result, mentionUserId, mentionUserName);
    } catch {
      await replyToLark(messageId, 'Lỗi khi phân tích câu hỏi, vui lòng kiểm tra lại cú pháp', mentionUserId, mentionUserName);
    }
  } catch {
    await replyToLark(messageId, 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long', mentionUserId, mentionUserName);
  } finally {
    pendingTasks.delete(messageId);
  }
}

/* ===========================
   EXISTING: createPieChartFromBaseData, sendChartToGroup, uploadImageToLark
   (kept unchanged)
   =========================== */
async function createPieChartFromBaseData(baseId, tableId, token, groupChatId) {
  try {
    const rows = await getAllRows(baseId, tableId, token);
    const fields = await getTableMeta(baseId, tableId, token);
    
    const categoryField = fields.find(f => f.name.toLowerCase() === 'manufactory')?.field_id;
    const valueField = fields.find(f => f.name.toLowerCase() === 'value')?.field_id;

    if (!categoryField || !valueField) return { success: false, message: 'Không tìm thấy cột Manufactory hoặc Value' };

    const dataMap = new Map();
    rows.forEach(row => {
      const fields = row.fields || {};
      const category = fields[categoryField] ? fields[categoryField].toString() : 'Unknown';
      const value = parseFloat(fields[valueField]) || 0;
      dataMap.set(category, (dataMap.get(category) || 0) + value);
    });

    const total = Array.from(dataMap.values()).reduce((a, b) => a + b, 0);
    const labels = [];
    const values = [];
    dataMap.forEach((value, label) => {
      labels.push(label);
      values.push((value / total * 100).toFixed(2));
    });

    const chart = new QuickChart();
    chart.setConfig({
      type: 'pie',
      data: { labels: labels, datasets: [{ data: values, backgroundColor: ['rgba(75, 192, 192, 0.2)', 'rgba(255, 99, 132, 0.2)', 'rgba(54, 162, 235, 0.2)', 'rgba(255, 206, 86, 0.2)', 'rgba(153, 102, 255, 0.2)', 'rgba(255, 159, 64, 0.2)'], borderColor: ['rgba(75, 192, 192, 1)', 'rgba(255, 99, 132, 1)', 'rgba(54, 162, 235, 1)', 'rgba(255, 206, 86, 1)', 'rgba(153, 102, 255, 1)', 'rgba(255, 159, 64, 1)'], borderWidth: 1 }] },
      options: { title: { display: true, text: 'Biểu đồ % Manufactory' }, plugins: { legend: { position: 'right' } } }
    });

    const chartUrl = await chart.getShortUrl();
    return { success: true, chartUrl };
  } catch {
    return { success: false, message: 'Lỗi khi tạo biểu đồ' };
  }
}

async function sendChartToGroup(token, chatId, chartUrl, messageText) {
  try {
    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages`,
      { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: await uploadImageToLark(chartUrl, token) }) },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages`,
      { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: messageText }) },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch {}
}

async function uploadImageToLark(imageUrl, token) {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const formData = new FormData();
    formData.append('image', buffer, { filename: 'chart.png' });
    formData.append('image_type', 'message');
    const uploadResp = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/images`,
      formData,
      { headers: { Authorization: `Bearer ${token}`, ...formData.getHeaders() } }
    );
    return uploadResp.data.data.image_key;
  } catch {
    throw new Error('Lỗi upload ảnh');
  }
}

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
   WEBHOOK: main incoming messages handler
   - tại đây mình thêm xử lý "Plan,":
     - Nếu user mention bot và message sau mention bắt đầu bằng "Plan," -> gọi processPlanQuery
     - Ngược lại giữ nguyên logic cũ
   =========================== */
app.post('/webhook', async (req, res) => {
  try {
    let bodyRaw = req.body.toString('utf8');
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) return res.sendStatus(401);

    let decryptedData = {};
    try {
      const { encrypt } = JSON.parse(bodyRaw);
      if (encrypt) decryptedData = decryptMessage(encrypt);
    } catch {}

    if (decryptedData.header && decryptedData.header.event_type === 'url_verification') {
      return res.json({ challenge: decryptedData.event.challenge });
    }

    if (decryptedData.header && decryptedData.header.event_type === 'im.message.receive_v1') {
      const senderId = decryptedData.event.sender.sender_id.open_id;
      const message = decryptedData.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const chatType = message.chat_type;
      const messageType = message.message_type;
      const parentId = message.parent_id;
      const mentions = message.mentions || [];

      if (chatType === 'group') {
        console.log(`BOT đang trò chuyện trong Group Chat ID: ${chatId}`);
      }

      if (processedMessageIds.has(messageId)) return res.sendStatus(200);
      processedMessageIds.add(messageId);

      if (senderId === (process.env.BOT_SENDER_ID || '')) return res.sendStatus(200);

      const isBotMentioned = mentions.some(mention => mention.id.open_id === BOT_OPEN_ID);

      let userMessage = '';
      try {
        userMessage = JSON.parse(message.content).text || '';
      } catch {}

      const hasAllMention = mentions.some(mention => mention.key === '@_all');
      if (hasAllMention && !isBotMentioned) return res.sendStatus(200);

      if (!isBotMentioned && messageType !== 'file' && messageType !== 'image') return res.sendStatus(200);

      res.sendStatus(200);

      const token = await getAppAccessToken();

      let mentionUserId = senderId;
      let mentionUserName = await getUserInfo(senderId, token);

      if (mentions.length > 0) {
        const userMention = mentions.find(mention => mention.id.open_id !== BOT_OPEN_ID && mention.id.open_id !== senderId);
        if (userMention) {
          mentionUserId = userMention.id.open_id;
          mentionUserName = await getUserInfo(mentionUserId, token);
        }
      }

      let baseId = '';
      let tableId = '';
      let spreadsheetToken = '';

      const mentionPrefix = `@_user_1 `;
      // lưu ý: userMessage có dạng "@_user_1 PUR, ...", hoặc "@_user_1 Plan, ..."
      if (userMessage.startsWith(mentionPrefix)) {
        const contentAfterMention = userMessage.slice(mentionPrefix.length).trim();

        // Nếu bắt đầu bằng Plan, -> kích hoạt Plan processing
        if (/^Plan[,，]\s*/i.test(contentAfterMention)) {
          // dùng SPREADSHEET_TOKEN + SHEET_ID (bạn đã định nghĩa)
          pendingTasks.set(messageId, { chatId, userMessage: contentAfterMention, mentionUserId, mentionUserName });
          // gọi ProcessPlanQuery
          await processPlanQuery(messageId, SPREADSHEET_TOKEN, contentAfterMention, token, mentionUserId, mentionUserName);
          return;
        }

        // nếu không phải Plan, giữ logic cũ để map BASE_MAPPINGS
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
      } else {
        // Nếu userMessage không theo dạng @_user_1 ... (không đi qua prefix handling),
        // nhưng vẫn có thể là "Plan, ..." (ví dụ mention format khác)
        const rawTrim = userMessage.trim();
        if (/^Plan[,，]\s*/i.test(rawTrim)) {
          pendingTasks.set(messageId, { chatId, userMessage: rawTrim, mentionUserId, mentionUserName });
          await processPlanQuery(messageId, SPREADSHEET_TOKEN, rawTrim, token, mentionUserId, mentionUserName);
          return;
        }
      }

      // Nếu đã tìm ra baseId/tableId -> xử lý base
      if (baseId && tableId) {
        pendingTasks.set(messageId, { chatId, userMessage, mentionUserId, mentionUserName });
        await processBaseData(messageId, baseId, tableId, userMessage, token);
      } else if (spreadsheetToken) {
        // Nếu có spreadsheetToken (nếu bạn muốn detect từ text), hiện không sử dụng tự động
        pendingTasks.set(messageId, { chatId, userMessage, mentionUserId, mentionUserName });
        await processSheetData(messageId, spreadsheetToken, userMessage, token, mentionUserId, mentionUserName);
      } else if (messageType === 'file' || messageType === 'image') {
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
            'File đã nhận. Vui lòng reply với câu hỏi hoặc yêu cầu (tag @L-GPT nếu cần). File sẽ bị xóa sau 5 phút nếu không reply.',
            mentionUserId,
            mentionUserName
          );
        } catch {
          await replyToLark(messageId, `Lỗi khi xử lý file ${message.file_name || 'không xác định'}.`, mentionUserId, mentionUserName);
        }
      } else if (messageType === 'post' && parentId) {
        const pendingFile = pendingFiles.get(chatId);
        if (pendingFile && pendingFile.messageId === parentId) {
          try {
            const { fileKey, fileName, ext } = pendingFile;

            const fileUrlResp = await axios.get(
              `${process.env.LARK_DOMAIN}/open-apis/im/v1/files/${fileKey}/download_url`,
              { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
            );
            const fileUrl = fileUrlResp.data.data.download_url;

            const extractedText = await extractFileContent(fileUrl, ext);
            if (extractedText.startsWith('Lỗi') || !extractedText) {
              await replyToLark(messageId, `Không thể trích xuất nội dung từ file ${fileName}.`, mentionUserId, mentionUserName);
            } else {
              const combinedMessage = userMessage + (extractedText ? `\nNội dung từ file: ${extractedText}` : '');
              updateConversationMemory(chatId, 'user', combinedMessage);
              const memory = conversationMemory.get(chatId) || [];
              const aiResp = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                  model: 'deepseek/deepseek-r1-0528:free',
                  messages: [...memory.map(({ role, content }) => ({ role, content })), { role: 'user', content: combinedMessage }],
                  stream: false,
                },
                {
                  headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
                  timeout: 20000,
                }
              );

              const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long';
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
      } else if (messageType === 'text' && userMessage.trim() && !baseId && !tableId) {
        try {
          updateConversationMemory(chatId, 'user', userMessage);
          const memory = conversationMemory.get(chatId) || [];
          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528:free',
              messages: [...memory.map(({ role, content }) => ({ role, content })), { role: 'user', content: userMessage }],
              stream: false,
            },
            {
              headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
              timeout: 20000,
            }
          );

          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long';
          const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
          updateConversationMemory(chatId, 'assistant', cleanMessage);
          await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
        } catch {
          await replyToLark(messageId, 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long', mentionUserId, mentionUserName);
        }
      } else {
        await replyToLark(messageId, 'Vui lòng sử dụng lệnh PUR, SALE, FIN, TEST kèm dấu phẩy và câu hỏi, hoặc gửi file/hình ảnh.', mentionUserId, mentionUserName);
      }
    }
  } catch {
    res.status(500).send('Lỗi máy chủ nội bộ');
  }
});

/* ===========================
   WEBHOOK-BASE: unchanged
   =========================== */
app.post('/webhook-base', async (req, res) => {
  try {
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const bodyRaw = JSON.stringify(req.body);

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) return res.status(401).send('Chữ ký không hợp lệ');

    if (req.body.event_type === 'url_verification') {
      return res.json({ challenge: req.body.event.challenge });
    }

    if (req.body.event_type === 'bitable.record.updated') {
      const event = req.body;
      const baseId = event.app_id;
      const tableId = event.table_id;
      const updateDate = event.fields['Update Date'];

      if (!updateDate || updateDate.includes('{{')) return res.sendStatus(200);

      const groupChatIds = (process.env.LARK_GROUP_CHAT_IDS || '').split(',').filter(id => id.trim());
      if (groupChatIds.length === 0) return res.status(400).send('Thiếu group chat IDs');

      const token = await getAppAccessToken();
      for (const chatId of groupChatIds) {
        const { success, chartUrl, message } = await createPieChartFromBaseData(baseId, tableId, token, chatId);

        if (success) {
          const messageText = `Biểu đồ % Manufactory đã được cập nhật (ngày ${updateDate})`;
          await sendChartToGroup(token, chatId, chartUrl, messageText);
        } else {
          await sendChartToGroup(token, chatId, null, message || 'Lỗi khi tạo biểu đồ');
        }
      }
      return res.sendStatus(200);
    }

    return res.status(400).send('Loại sự kiện không được hỗ trợ');
  } catch {
    res.status(500).send('Lỗi máy chủ nội bộ');
  }
});

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
