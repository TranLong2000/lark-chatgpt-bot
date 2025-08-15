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
const SHEET_ID = '48e2fd';
const GROUP_CHAT_IDS = (process.env.LARK_GROUP_CHAT_IDS || '').split(',').filter(id => id.trim());
const BOT_OPEN_ID = 'ou_28e2a5e298050b5f08899314b2d49300';

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

async function getSheetData(spreadsheetToken, token, range = 'A:Z') {
  const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`;
  try {
    const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    return resp.data.data.valueRange.values || [];
  } catch {
    return [];
  }
}

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

async function sendMessageToGroup(token, chatId, messageText) {
  try {
    const payload = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: messageText })
    };
    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.log('Lỗi gửi tin nhắn:', err.message);
  }
}

async function checkB2ValueChange() {
  try {
    const token = await getAppAccessToken();
    const currentB2Value = await getCellB2Value(token);

    console.log('Đã đổ số:', { current: currentB2Value, last: lastB2Value });

    if (currentB2Value !== null && currentB2Value !== lastB2Value && lastB2Value !== null) {
      const messageText = `Tổng cột G hiện tại: ${currentB2Value}`;
      const analysisPrompt = `
        Bạn là một trợ lý AI. Dựa trên thông tin sau:
        - Tổng cột G: ${currentB2Value}
        Hãy phân tích và trả lời ngắn gọn dưới dạng JSON: { "result": string }.
      `;
      const aiResponse = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-r1-0528:free',
          messages: [
            { role: 'system', content: 'Bạn là một trợ lý AI chuyên phân tích dữ liệu với ít token nhất. Luôn trả lời dưới dạng JSON hợp lệ.' },
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
      ).catch(err => console.log('Lỗi API phân tích:', err.message));
      const aiContent = aiResponse?.data.choices[0]?.message.content.trim();
      let analysis;
      try {
        analysis = JSON.parse(aiContent);
        messageText += `. ${analysis.result}`;
      } catch {}

      const mentionUserId = BOT_OPEN_ID;
      const mentionUserName = 'L-GPT';
      for (const chatId of GROUP_CHAT_IDS) {
        await sendMessageToGroup(token, chatId, messageText).catch(err => console.log('Lỗi gửi tin nhắn nhóm:', err.message));
      }
    } else if (lastB2Value === null && currentB2Value !== null) {
    } else if (currentB2Value === null) {
    }

    lastB2Value = currentB2Value;
  } catch (err) {
    console.log('Lỗi checkB2ValueChange:', err.message);
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

process.on('SIGTERM', () => {
  pendingTasks.forEach((task, messageId) => replyToLark(messageId, 'Xử lý bị gián đoạn.', task.mentionUserId, task.mentionUserName));
  process.exit(0);
});

setInterval(() => {
  conversationMemory.clear();
}, 2 * 60 * 60 * 1000);

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
      const messageType = message.message_type;
      const parentId = message.parent_id;
      const mentions = message.mentions || [];

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
      if (userMessage.startsWith(mentionPrefix)) {
        const contentAfterMention = userMessage.slice(mentionPrefix.length);
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
      }

      if (baseId && tableId) {
        pendingTasks.set(messageId, { chatId, userMessage, mentionUserId, mentionUserName });
        await processBaseData(messageId, baseId, tableId, userMessage, token);
      } else if (spreadsheetToken) {
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

app.listen(port, () => {
  checkB2ValueChange();
  setInterval(checkB2ValueChange, 5 * 60 * 1000);
});

setInterval(() => {
  const now = Date.now();
  for (const [chatId, file] of pendingFiles) {
    if (now - file.timestamp > 5 * 60 * 1000) pendingFiles.delete(chatId);
  }
}, 60 * 1000);
