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

let lastB2Value = null;
const SPREADSHEET_TOKEN = 'LYYqsXmnPhwwGHtKP00lZ1IWgDb';
const SHEET_ID = 'hZ0ZAX';
const GROUP_CHAT_IDS = (process.env.LARK_GROUP_CHAT_IDS || '').split(',').filter(id => id.trim());

const processedMessageIds = new Set();
const conversationMemory = new Map();
const pendingTasks = new Map();
const pendingFiles = new Map();

if (!fs.existsSync('temp_files')) {
  fs.mkdirSync('temp_files');
}

app.use('/webhook', express.raw({ type: '*/*', limit: '10mb', timeout: 60000 }));
app.use('/webhook-base', express.json({ limit: '10mb', timeout: 60000 }));

function verifySignature(timestamp, nonce, body, signature) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  console.log('[VerifySignature] Timestamp:', timestamp, 'Nonce:', nonce, 'EncryptKey exists:', !!encryptKey);
  if (!encryptKey) {
    console.error('[VerifySignature] LARK_ENCRYPT_KEY chưa được thiết lập');
    return false;
  }
  const raw = `${timestamp}${nonce}${encryptKey}${body}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  console.log('[VerifySignature] Calculated hash:', hash, 'Signature:', signature);
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

async function getUserInfo(openId, token) {
  try {
    const response = await axios.get(`${process.env.LARK_DOMAIN}/open-apis/contact/v3/users/${openId}?user_id_type=open_id`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const user = response.data.data.user;
    return user.name || `User_${openId.slice(-4)}`;
  } catch (err) {
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
    if (mentionUserId && mentionUserName && mentionUserId !== process.env.BOT_OPEN_ID) {
      console.log('[Reply Debug] Tagging user:', mentionUserId, mentionUserName);
      messageContent = { text: `${content} <at user_id="${mentionUserId}">${mentionUserName}</at>` };
    } else {
      messageContent = { text: content };
    }

    const response = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages/${messageId}/reply`,
      { msg_type: msgType, content: JSON.stringify(messageContent) },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log('[Reply Success] Response:', response.data);
  } catch (err) {
    console.error('[Reply Error]', err?.response?.data || err.message);
  }
}

async function extractFileContent(fileUrl, fileType) {
  try {
    console.log('[ExtractFileContent] Đang tải file:', fileUrl, 'với type:', fileType);
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const buffer = Buffer.from(response.data);

    if (fileType === 'pdf') {
      console.log('[ExtractFileContent] Đang xử lý PDF...');
      const data = await pdfParse(buffer);
      return data.text.trim();
    }
    if (fileType === 'docx') {
      console.log('[ExtractFileContent] Đang xử lý DOCX...');
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim();
    }
    if (fileType === 'xlsx') {
      console.log('[ExtractFileContent] Đang xử lý XLSX...');
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
      return sheet.map(row => row.join(', ')).join('; ');
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileType)) {
      console.log('[ExtractFileContent] Đang thực hiện OCR cho hình ảnh...');
      const result = await Tesseract.recognize(buffer, 'eng+vie', { logger: m => console.log('[Tesseract]', m) });
      return result.data.text.trim();
    }
    console.log('[ExtractFileContent] Không hỗ trợ loại file:', fileType);
    return 'Không hỗ trợ loại file này.';
  } catch (err) {
    console.error('[ExtractFileContent Error] Nguyên nhân:', err.message, 'URL:', fileUrl, 'Type:', fileType);
    return `Lỗi khi trích xuất nội dung file: ${err.message}`;
  }
}

async function extractImageContent(imageData) {
  try {
    console.log('[ExtractImageContent] Đang thực hiện OCR...');
    const result = await Tesseract.recognize(imageData, 'eng+vie', { logger: m => console.log('[Tesseract]', m) });
    return result.data.text.trim();
  } catch (err) {
    console.error('[ExtractImageContent Error] Nguyên nhân:', err.message);
    return `Lỗi khi trích xuất nội dung hình ảnh: ${err.message}`;
  }
}

async function getAppAccessToken() {
  try {
    const resp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`, {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }, { timeout: 20000 });
    console.log('[Debug] Token được tạo:', resp.data.app_access_token);
    return resp.data.app_access_token;
  } catch (err) {
    console.error('[GetAppAccessToken Error]', err?.response?.data || err.message);
    throw err;
  }
}

async function logBotOpenId() {
  try {
    const token = await getAppAccessToken();
    const response = await axios.get(`${process.env.LARK_DOMAIN}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    const botOpenId = response.data.bot.open_id;
    console.log('[Bot Info] BOT_OPEN_ID:', botOpenId);
    return botOpenId;
  } catch (err) {
    console.error('[LogBotOpenId Error]', err?.response?.data || err.message);
    return null;
  }
}

async function getTableMeta(baseId, tableId, token) {
  try {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/meta`;
    console.log('[getTableMeta] Gọi API với URL:', url);
    const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    console.log('[getTableMeta] Phản hồi thành công:', JSON.stringify(resp.data.data.fields.slice(0, 5)));
    return resp.data.data.fields.map(field => ({
      name: field.name,
      field_id: field.field_id,
    }));
  } catch (err) {
    console.warn('[getTableMeta Error] Nguyên nhân:', err.response?.data || err.message, 'Status:', err.response?.status);
    return [];
  }
}

async function getAllRows(baseId, tableId, token, requiredFields = []) {
  if (global.lastRows && global.lastRows.baseId === baseId && global.lastRows.tableId === tableId) {
    console.log('[getAllRows] Sử dụng dữ liệu đã lấy:', global.lastRows.rows.length, 'dòng');
    return global.lastRows.rows;
  }

  const rows = [];
  let pageToken = '';
  do {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=20&page_token=${pageToken}`;
    try {
      console.log('[getAllRows] Đang lấy dữ liệu, số dòng hiện tại:', rows.length, 'cho baseId:', baseId, 'tableId:', tableId);
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: requiredFields.length > 0 ? { field_names: requiredFields.join(',') } : {},
        timeout: 30000,
      });
      if (!resp.data || !resp.data.data) {
        console.error('[getAllRows] Phản hồi API không hợp lệ:', JSON.stringify(resp.data));
        break;
      }
      rows.push(...(resp.data.data.items || []));
      pageToken = resp.data.data.page_token || '';
      console.log('[getAllRows] Lấy thêm:', rows.length - (resp.data.data.items?.length || 0), 'đến', rows.length);
    } catch (e) {
      console.error('[getAllRows] Lỗi:', e.response?.data || e.message, 'Status:', e.response?.status);
      break;
    }
  } while (pageToken && rows.length < 100);
  console.log('[getAllRows] Tổng số dòng lấy được:', rows.length, 'Dữ liệu mẫu:', JSON.stringify(rows.slice(0, 5)));
  global.lastRows = { baseId, tableId, rows };
  return rows;
}

async function getSheetData(spreadsheetToken, token, range = 'A:Z') {
  const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/values/${range}?valueRenderOption=FORMATTED_VALUE`;
  console.log('[getSheetData] Gọi API với URL:', url);
  try {
    const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    return resp.data.data.valueRange.values || [];
  } catch (err) {
    console.error('[getSheetData Error]', err?.response?.data || err.message);
    return [];
  }
}

async function getCellB2Value(token) {
  try {
    const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v3/spreadsheets/${SPREADSHEET_TOKEN}/values/${SHEET_ID}!B2:B2?valueRenderOption=FORMATTED_VALUE`;
    console.log('[getCellB2Value] Gọi API với URL:', url, 'Token:', token);
    const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    console.log('[getCellB2Value] Phản hồi đầy đủ:', JSON.stringify(resp.data));
    const values = resp.data.data.valueRange.values;
    console.log('[getCellB2Value] Dữ liệu nhận được:', values);
    if (values && values[0] && values[0][0]) {
      return values[0][0].toString().trim();
    }
    return null;
  } catch (err) {
    console.error('[getCellB2Value Error]', JSON.stringify(err?.response?.data || err.message), 'Status:', err?.response?.status);
    return null;
  }
}

async function sendMessageToGroup(token, chatId, messageText) {
  try {
    const payload = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: messageText })
    };
    console.log('[sendMessageToGroup] Gửi yêu cầu với payload:', JSON.stringify(payload));
    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log('[sendMessageToGroup] Đã gửi tin nhắn đến group:', chatId, 'Nội dung:', messageText);
  } catch (err) {
    console.error('[sendMessageToGroup Error] Group:', chatId, 'Nguyên nhân:', JSON.stringify(err?.response?.data || err.message), 'Status:', err?.response?.status);
  }
}

async function checkB2ValueChange() {
  try {
    const token = await getAppAccessToken();
    const currentB2Value = await getCellB2Value(token);

    console.log('[checkB2ValueChange] Giá trị B2 hiện tại:', currentB2Value, 'Giá trị trước đó:', lastB2Value);

    if (currentB2Value !== null && currentB2Value !== lastB2Value && lastB2Value !== null) {
      const messageText = 'Đã đổ số';
      for (const chatId of GROUP_CHAT_IDS) {
        await sendMessageToGroup(token, chatId, messageText);
      }
    } else if (lastB2Value === null && currentB2Value !== null) {
      console.log('[checkB2ValueChange] Khởi tạo giá trị B2 ban đầu:', currentB2Value);
    } else if (currentB2Value === null) {
      console.log('[checkB2ValueChange] Ô B2 hiện tại trống hoặc không đọc được');
    }

    lastB2Value = currentB2Value;
  } catch (err) {
    console.error('[checkB2ValueChange Error]', err.message);
  }
}

function updateConversationMemory(chatId, role, content) {
  if (!conversationMemory.has(chatId)) {
    conversationMemory.set(chatId, []);
  }
  const mem = conversationMemory.get(chatId);
  mem.push({ role, content });
  if (mem.length > 10) mem.shift();
}

async function analyzeQueryAndProcessData(userMessage, baseId, tableId, token) {
  try {
    const fields = await getTableMeta(baseId, tableId, token);
    const fieldNames = fields.length > 0 ? fields.map(f => f.name) : [];
    console.log('[Debug] Các cột trong bảng:', fieldNames);

    const rows = await getAllRows(baseId, tableId, token);
    const allRows = rows.map(row => row.fields || {});

    if (!allRows || allRows.length === 0) {
      console.log('[Debug] Không có dữ liệu trong Base');
      return { result: 'Không có dữ liệu trong Base' };
    }

    const validRows = allRows.filter(row => row && typeof row === 'object');
    if (validRows.length === 0) {
      console.log('[Debug] Không có hàng hợp lệ');
      return { result: 'Không có hàng hợp lệ' };
    }

    const headerRow = validRows[0];
    const columnMapping = {};
    if (headerRow) {
      Object.keys(headerRow).forEach((fieldId, index) => {
        columnMapping[fieldId] = fieldNames[index] || fieldId;
      });
    }
    console.log('[Debug] Ánh xạ cột:', columnMapping);

    const columnData = {};
    Object.keys(columnMapping).forEach(fieldId => {
      columnData[columnMapping[fieldId]] = validRows.map(row => row[fieldId] ? row[fieldId].toString().trim() : null);
    });
    console.log('[Debug] Dữ liệu cột:', columnData);

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

    console.log('[Debug] Gửi prompt đến OpenRouter:', analysisPrompt);
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
    let analysis;
    try {
      analysis = JSON.parse(aiContent);
      console.log('[Debug] Phân tích AI:', analysis);
    } catch (parseError) {
      console.error('[Debug] Phân tích AI thất bại, nội dung:', aiContent, 'Lỗi:', parseError.message);
      return { result: 'Lỗi khi phân tích câu hỏi, vui lòng kiểm tra lại cú pháp' };
    }

    return analysis;
  } catch (e) {
    console.error('[Analysis Error] Nguyên nhân:', e.message, 'Stack:', e.stack);
    return { result: 'Lỗi khi xử lý, vui lòng liên hệ Admin Long' };
  }
}

async function processBaseData(messageId, baseId, tableId, userMessage, token) {
  try {
    const { result } = await analyzeQueryAndProcessData(userMessage, baseId, tableId, token);
    const chatId = pendingTasks.get(messageId)?.chatId;
    updateConversationMemory(chatId, 'user', userMessage);
    updateConversationMemory(chatId, 'assistant', result);
    await replyToLark(messageId, result, pendingTasks.get(messageId)?.mentionUserId, pendingTasks.get(messageId)?.mentionUserName);
  } catch (e) {
    console.error('[Base API Error] Nguyên nhân:', e?.response?.data || e.message, 'Stack:', e.stack);
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
    console.log('[Debug] Dữ liệu cột từ Sheet:', columnData);

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

    console.log('[Debug] Gửi prompt đến OpenRouter:', analysisPrompt);
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
    let analysis;
    try {
      analysis = JSON.parse(aiContent);
      console.log('[Debug] Phân tích AI:', analysis);
    } catch (parseError) {
      console.error('[Debug] Phân tích AI thất bại, nội dung:', aiContent, 'Lỗi:', parseError.message);
      await replyToLark(messageId, 'Lỗi khi phân tích câu hỏi, vui lòng kiểm tra lại cú pháp', mentionUserId, mentionUserName);
      return;
    }

    updateConversationMemory(chatId, 'user', userMessage);
    updateConversationMemory(chatId, 'assistant', analysis.result);
    await replyToLark(messageId, analysis.result, mentionUserId, mentionUserName);
  } catch (e) {
    console.error('[Sheet API Error] Nguyên nhân:', e?.response?.data || e.message, 'Stack:', e.stack);
    await replyToLark(messageId, 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long', mentionUserId, mentionUserName);
  } finally {
    pendingTasks.delete(messageId);
  }
}

async function createPieChartFromBaseData(baseId, tableId, token, groupChatId) {
  try {
    const rows = await getAllRows(baseId, tableId, token);
    const fields = await getTableMeta(baseId, tableId, token);
    
    const categoryField = fields.find(f => f.name.toLowerCase() === 'manufactory')?.field_id;
    const valueField = fields.find(f => f.name.toLowerCase() === 'value')?.field_id;

    if (!categoryField || !valueField) {
      return { success: false, message: 'Không tìm thấy cột Manufactory hoặc Value phù hợp để tạo biểu đồ' };
    }

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
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: [
            'rgba(75, 192, 192, 0.2)',
            'rgba(255, 99, 132, 0.2)',
            'rgba(54, 162, 235, 0.2)',
            'rgba(255, 206, 86, 0.2)',
            'rgba(153, 102, 255, 0.2)',
            'rgba(255, 159, 64, 0.2)'
          ],
          borderColor: [
            'rgba(75, 192, 192, 1)',
            'rgba(255, 99, 132, 1)',
            'rgba(54, 162, 235, 1)',
            'rgba(255, 206, 86, 1)',
            'rgba(153, 102, 255, 1)',
            'rgba(255, 159, 64, 1)'
          ],
          borderWidth: 1
        }]
      },
      options: {
        title: {
          display: true,
          text: 'Biểu đồ % Manufactory (Cập nhật hàng ngày)'
        },
        plugins: {
          legend: { position: 'right' }
        }
      }
    });

    const chartUrl = await chart.getShortUrl();
    console.log('[Chart] Đã tạo biểu đồ cho group:', groupChatId, 'URL:', chartUrl);
    return { success: true, chartUrl };
  } catch (err) {
    console.error('[CreatePieChart Error]', err.message, 'Group:', groupChatId);
    return { success: false, message: `Lỗi khi tạo biểu đồ: ${err.message}` };
  }
}

async function sendChartToGroup(token, chatId, chartUrl, messageText) {
  try {
    const response = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages`,
      {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: await uploadImageToLark(chartUrl, token) })
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log('[SendChart] Đã gửi biểu đồ đến group:', chatId, 'Response:', response.data);

    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages`,
      {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: messageText })
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[SendChart Error] Group:', chatId, 'Nguyên nhân:', err?.response?.data || err.message);
  }
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
  } catch (err) {
    console.error('[UploadImage Error]', err?.response?.data || err.message);
    throw err;
  }
}

process.on('SIGTERM', () => {
  console.log('[Server] Nhận tín hiệu SIGTERM, đang tắt...');
  pendingTasks.forEach((task, messageId) => replyToLark(messageId, 'Xử lý bị gián đoạn.', task.mentionUserId, task.mentionUserName));
  process.exit(0);
});

setInterval(() => {
  conversationMemory.clear();
  console.log('[Memory] Đã xóa bộ nhớ');
}, 2 * 60 * 60 * 1000);

app.post('/webhook', async (req, res) => {
  try {
    console.log('[Webhook Debug] Raw Buffer Length:', req.body.length);
    console.log('[Webhook Debug] Raw Buffer (Hex):', Buffer.from(req.body).toString('hex'));
    console.log('[Webhook Debug] Raw Buffer:', req.body.toString('utf8'));
    let bodyRaw = req.body.toString('utf8');
    console.log('[Webhook Debug] Parsed Body:', bodyRaw);
    console.log('[Webhook Debug] All Headers:', JSON.stringify(req.headers, null, 2));

    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      console.warn('[Webhook] Bỏ qua kiểm tra chữ ký để debug. Kiểm tra LARK_ENCRYPT_KEY sau. Request Body:', bodyRaw);
    } else {
      console.log('[VerifySignature] Chữ ký hợp lệ, tiếp tục xử lý');
    }

    let decryptedData = {};
    try {
      const { encrypt } = bodyRaw ? JSON.parse(bodyRaw) : {};
      if (encrypt) {
        decryptedData = decryptMessage(encrypt);
        console.log('[Webhook Debug] Decrypted Data:', JSON.stringify(decryptedData));
      } else {
        console.error('[Webhook Debug] Không tìm thấy trường encrypt trong body:', bodyRaw);
      }
    } catch (parseError) {
      console.error('[Webhook Debug] Lỗi khi parse body:', parseError.message, 'Raw Body:', bodyRaw);
    }

    if (decryptedData.header && decryptedData.header.event_type === 'url_verification') {
      return res.json({ challenge: decryptedData.event.challenge });
    }

    if (decryptedData.event && decryptedData.event.chat_id) {
      console.log('[Group Chat ID] ID của group chat:', decryptedData.event.chat_id);
    }

    if (decryptedData.header && decryptedData.header.event_type === 'im.message.receive_v1') {
      const senderId = decryptedData.event.sender.sender_id.open_id;
      const message = decryptedData.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const messageType = message.message_type;
      const parentId = message.parent_id;
      const mentions = message.mentions || [];

      console.log('[Message Debug] chatId:', chatId, 'messageId:', messageId, 'parentId:', parentId, 'messageType:', messageType, 'Full Message:', JSON.stringify(message));
      console.log('[Mentions Debug] Mentions:', JSON.stringify(mentions, null, 2));

      if (processedMessageIds.has(messageId)) return res.sendStatus(200);
      processedMessageIds.add(messageId);

      if (senderId === (process.env.BOT_SENDER_ID || '')) return res.sendStatus(200);

      const botOpenId = process.env.BOT_OPEN_ID;
      const isBotMentioned = mentions.some(mention => mention.id.open_id === botOpenId);

      let userMessage = '';
      try {
        const parsed = JSON.parse(message.content);
        userMessage = parsed.text || '';
      } catch (err) {
        console.error('[Parse Content Error] Nguyên nhân:', err.message, 'Content:', message.content);
      }

      const hasAllMention = mentions.some(mention => mention.key === '@_all');
      if (hasAllMention && !isBotMentioned) {
        return res.sendStatus(200);
      }

      if (!isBotMentioned && messageType !== 'file' && messageType !== 'image') {
        return res.sendStatus(200);
      }

      res.sendStatus(200);

      const token = await getAppAccessToken();

      let mentionUserId = senderId;
      let mentionUserName = await getUserInfo(senderId, token);
      console.log('[Sender Debug] senderId:', senderId, 'senderName:', mentionUserName);

      if (mentions.length > 0) {
        const userMention = mentions.find(mention => mention.id.open_id !== botOpenId && mention.id.open_id !== senderId);
        if (userMention) {
          mentionUserId = userMention.id.open_id;
          mentionUserName = await getUserInfo(mentionUserId, token);
          console.log('[User Debug] mentionUserId:', mentionUserId, 'mentionUserName:', mentionUserName);
        }
      }

      let baseId = '';
      let tableId = '';
      let spreadsheetToken = '';

      const mentionPrefix = `@_user_1 `;
      let reportMatch;
      if (userMessage.startsWith(mentionPrefix)) {
        const contentAfterMention = userMessage.slice(mentionPrefix.length);
        reportMatch = contentAfterMention.match(new RegExp(`^(${Object.keys(BASE_MAPPINGS).join('|')})(,|,)`, 'i'));
        if (reportMatch) {
          const reportName = reportMatch[1].toUpperCase();
          const reportUrl = BASE_MAPPINGS[reportName];
          if (reportUrl) {
            console.log('[Webhook] Processing report:', reportName, 'URL:', reportUrl);
            const urlMatch = reportUrl.match(/base\/([a-zA-Z0-9]+)\?.*table=([a-zA-Z0-9]+)/);
            if (urlMatch) {
              baseId = urlMatch[1];
              tableId = urlMatch[2];
              console.log('[Webhook] Extracted baseId:', baseId, 'tableId:', tableId);
            } else {
              console.error('[Webhook] Failed to extract baseId/tableId from URL:', reportUrl);
            }
          }
        }
      }

      if (baseId && tableId) {
        console.log('[Webhook] Triggering processBaseData for:', reportMatch ? reportMatch[1].toUpperCase() : 'unknown');
        pendingTasks.set(messageId, { chatId, userMessage, mentionUserId, mentionUserName });
        await processBaseData(messageId, baseId, tableId, userMessage, token);
      } else if (spreadsheetToken) {
        pendingTasks.set(messageId, { chatId, userMessage, mentionUserId, mentionUserName });
        await processSheetData(messageId, spreadsheetToken, userMessage, token, mentionUserId, mentionUserName);
      } else if (messageType === 'file' || messageType === 'image') {
        try {
          console.log('[File/Image Debug] Processing message type:', messageType, 'Full Message:', JSON.stringify(message));
          const fileKey = message.file_key;
          if (!fileKey) {
            console.error('[File/Image Debug] Nguyên nhân: Không tìm thấy file_key trong message', 'Message:', JSON.stringify(message));
            await replyToLark(
              messageId,
              'Không tìm thấy file_key. Vui lòng kiểm tra lại file hoặc gửi lại.',
              mentionUserId,
              mentionUserName
            );
            return;
          }

          const fileName = message.file_name || `${messageId}.${messageType === 'image' ? 'jpg' : 'bin'}`;
          const ext = path.extname(fileName).slice(1).toLowerCase();
          console.log('[File/Image Debug] File key:', fileKey, 'File name:', fileName, 'Extension:', ext);

          pendingFiles.set(chatId, { fileKey, fileName, ext, messageId, timestamp: Date.now() });

          await replyToLark(
            messageId,
            'File đã nhận. Vui lòng reply tin nhắn này với câu hỏi hoặc yêu cầu (tag @L-GPT nếu cần). File sẽ bị xóa khỏi bộ nhớ sau 5 phút nếu không có reply.',
            mentionUserId,
            mentionUserName
          );
        } catch (err) {
          console.error('[File Processing Error] Nguyên nhân:', err?.response?.data || err.message, 'Message:', JSON.stringify(message));
          await replyToLark(
            messageId,
            `Lỗi khi xử lý file ${message.file_name || 'không xác định'}. Nguyên nhân: ${err.message}`,
            mentionUserId,
            mentionUserName
          );
        }
      } else if (messageType === 'post' && parentId) {
        const pendingFile = pendingFiles.get(chatId);
        if (pendingFile && pendingFile.messageId === parentId) {
          try {
            console.log('[Post Debug] Processing reply with file, parentId:', parentId, 'pendingFile:', JSON.stringify(pendingFile));
            const { fileKey, fileName, ext } = pendingFile;

            const fileUrlResp = await axios.get(
              `${process.env.LARK_DOMAIN}/open-apis/im/v1/files/${fileKey}/download_url`,
              { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
            );
            const fileUrl = fileUrlResp.data.data.download_url;
            console.log('[Post Debug] Download URL:', fileUrl);

            const extractedText = await extractFileContent(fileUrl, ext);
            console.log('[Post Debug] Extracted text:', extractedText);

            if (extractedText.startsWith('Lỗi') || !extractedText) {
              await replyToLark(
                messageId,
                `Không thể trích xuất nội dung từ file ${fileName}. Nguyên nhân: ${extractedText}`,
                mentionUserId,
                mentionUserName
              );
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
                  headers: {
                    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                  },
                  timeout: 20000,
                }
              );

              const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long';
              const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
              updateConversationMemory(chatId, 'assistant', cleanMessage);
              await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
            }
            pendingFiles.delete(chatId);
          } catch (err) {
            console.error('[Post Processing Error] Nguyên nhân:', err?.response?.data || err.message);
            await replyToLark(
              messageId,
              `Lỗi khi xử lý file ${pendingFile.fileName}. Nguyên nhân: ${err.message}`,
              mentionUserId,
              mentionUserName
            );
            pendingFiles.delete(chatId);
          }
        } else {
          console.log('[Post Debug] No matching file found for parentId:', parentId, 'pendingFiles:', JSON.stringify(pendingFiles));
          await replyToLark(
            messageId,
            'Vui lòng reply trực tiếp tin nhắn chứa file để mình xử lý. Nếu đã gửi file, hãy gửi lại file hoặc kiểm tra lại quy trình.',
            mentionUserId,
            mentionUserName
          );
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
              headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
              },
              timeout: 20000,
            }
          );

          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long';
          const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
          updateConversationMemory(chatId, 'assistant', cleanMessage);
          await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
        } catch (e) {
          console.error('[AI Error] Nguyên nhân:', e?.response?.data?.msg || e.message);
          let errorMessage = 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long';
          if (e.code === 'ECONNABORTED') {
            errorMessage = 'Hết thời gian chờ khi gọi API AI, vui lòng thử lại sau hoặc kiểm tra kết nối mạng.';
          }
          await replyToLark(messageId, errorMessage, mentionUserId, mentionUserName);
        }
      } else {
        await replyToLark(
          messageId,
          'Vui lòng sử dụng lệnh PUR, SALE, FIN hoặc TEST kèm dấu phẩy và câu hỏi, hoặc gửi file/hình ảnh.',
          mentionUserId,
          mentionUserName
        );
      }
    }
  } catch (e) {
    console.error('[Webhook Handler Error] Nguyên nhân:', e.message, 'Request Body:', req.body.toString('utf8') || 'Không có dữ liệu', 'Stack:', e.stack);
    res.status(500).send('Lỗi máy chủ nội bộ');
  }
});

app.post('/webhook-base', async (req, res) => {
  try {
    console.log('[Webhook-Base Debug] Raw Body as String:', req.body.toString());
    console.log('[Webhook-Base Debug] All Headers:', JSON.stringify(req.headers, null, 2));

    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const bodyRaw = JSON.stringify(req.body);

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      console.warn('[Webhook-Base] Chữ ký không hợp lệ hoặc không kiểm tra được. Request Body:', bodyRaw);
      return res.status(401).send('Chữ ký không hợp lệ');
    }
    console.log('[Webhook-Base] Chữ ký hợp lệ, tiếp tục xử lý');

    if (req.body.event_type === 'url_verification') {
      return res.json({ challenge: req.body.event.challenge });
    }

    if (req.body.event_type === 'bitable.record.updated') {
      const event = req.body;
      const baseId = event.app_id;
      const tableId = event.table_id;
      const updateDate = event.fields['Update Date'];

      if (!updateDate || updateDate.includes('{{')) {
        console.warn('[Webhook-Base] Update Date không hợp lệ hoặc chứa placeholder ({{...}}), bỏ qua. Payload:', JSON.stringify(event.fields));
        return res.sendStatus(200);
      }

      const groupChatIds = (process.env.LARK_GROUP_CHAT_IDS || '').split(',').filter(id => id.trim());
      if (groupChatIds.length === 0) {
        console.error('[Webhook-Base] LARK_GROUP_CHAT_IDS chưa được thiết lập hoặc rỗng');
        return res.status(400).send('Thiếu group chat IDs');
      }

      const token = await getAppAccessToken();
      for (const chatId of groupChatIds) {
        console.log('[Webhook-Base] Xử lý gửi đến group:', chatId);
        const { success, chartUrl, message } = await createPieChartFromBaseData(baseId, tableId, token, chatId);

        if (success) {
          const messageText = `Biểu đồ % Manufactory đã được cập nhật (ngày ${updateDate})`;
          await sendChartToGroup(token, chatId, chartUrl, messageText);
        } else {
          await sendChartToGroup(token, chatId, null, message || 'Lỗi khi tạo biểu đồ từ dữ liệu Base');
        }
      }
      return res.sendStatus(200);
    }

    console.warn('[Webhook-Base] Loại sự kiện không được hỗ trợ:', req.body.event_type);
    return res.status(400).send('Loại sự kiện không được hỗ trợ');
  } catch (e) {
    console.error('[Webhook-Base Handler Error] Nguyên nhân:', e.message, 'Request Body:', JSON.stringify(req.body) || 'Không có dữ liệu', 'Stack:', e.stack);
    res.status(500).send('Lỗi máy chủ nội bộ');
  }
});

logBotOpenId().then(() => {
  app.listen(port, () => {
    console.log(`Máy chủ đang chạy trên cổng ${port}`);
    checkB2ValueChange();
    setInterval(checkB2ValueChange, 5 * 60 * 1000);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [chatId, file] of pendingFiles) {
    if (now - file.timestamp > 5 * 60 * 1000) {
      console.log('[Cleanup] Xóa file từ pendingFiles do hết thời gian:', chatId, file.fileName);
      pendingFiles.delete(chatId);
    }
  }
}, 60 * 1000);
