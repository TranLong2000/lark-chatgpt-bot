// index.js (đã sửa, đầy đủ)
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
const FormData = require('form-data');
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
  try {
    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY || '', 'utf-8');
    const aesKey = crypto.createHash('sha256').update(key).digest();
    const data = Buffer.from(encrypt, 'base64');
    const iv = data.slice(0, 16);
    const encryptedText = data.slice(16);

    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (e) {
    console.log('decryptMessage error', e.message || e);
    return null;
  }
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
    const token = await getAppAccessToken();
    let messageContent;
    const msgType = 'text';
    if (mentionUserId && mentionUserName && mentionUserId !== BOT_OPEN_ID) {
      messageContent = { text: `${content} <at user_id="${mentionUserId}">${mentionUserName}</at>` };
    } else {
      messageContent = { text: content };
    }

    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages/${messageId}/reply`,
      { msg_type: msgType, content: JSON.stringify(messageContent) },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
  } catch (err) {
    console.log('replyToLark error:', err.response?.data || err.message);
  }
}

async function extractFileContent(fileUrl, fileType) {
  try {
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const buffer = Buffer.from(response.data);

    if (fileType === 'pdf') {
      const data = await pdfParse(buffer);
      return data.text.trim();
    }
    if (fileType === 'docx' || fileType === 'doc') {
      const result = await mammoth.extractRawText({ buffer });
      return (result.value || '').trim();
    }
    if (fileType === 'xlsx' || fileType === 'xls') {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
      return sheet.map(row => row.join(', ')).join('; ');
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes((fileType || '').toLowerCase())) {
      const result = await Tesseract.recognize(buffer, 'eng+vie');
      return result.data.text.trim();
    }
    return 'Không hỗ trợ loại file này.';
  } catch (e) {
    console.log('extractFileContent error:', e.response?.data || e.message);
    return 'Lỗi khi trích xuất nội dung file';
  }
}

async function extractImageContent(imageData) {
  try {
    const result = await Tesseract.recognize(imageData, 'eng+vie');
    return result.data.text.trim();
  } catch (e) {
    console.log('extractImageContent error:', e.message);
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
  } catch (e) {
    console.log('getAppAccessToken error:', e.response?.data || e.message);
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
  } catch (e) {
    console.log('getSheetData error:', e.response?.data || e.message);
    return [];
  }
}

// upload image util
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
      { headers: { Authorization: `Bearer ${token}`, ...formData.getHeaders() }, timeout: 30000 }
    );
    return uploadResp.data.data.image_key;
  } catch (e) {
    console.log('uploadImageToLark error:', e.response?.data || e.message);
    throw new Error('Lỗi upload ảnh');
  }
}

async function sendChartToGroup(token, chatId, chartUrl, messageText) {
  try {
    const imageKey = await uploadImageToLark(chartUrl, token);
    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages`,
      { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages`,
      { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: messageText }) },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
  } catch (e) {
    console.log('sendChartToGroup error:', e.response?.data || e.message);
  }
}

// helpers
function _toNum(v) {
  if (v === undefined || v === null) return 0;
  const n = parseFloat(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function _norm(s) {
  return String(s || '').trim().toLowerCase();
}

function _findKey(sampleObj, candidates) {
  const keys = Object.keys(sampleObj || {});
  for (const k of keys) {
    const nk = _norm(k);
    if (candidates.some(c => nk.includes(_norm(c)))) return k;
  }
  return null;
}

// Send text to groups using app token
async function sendMessageToGroups(token, text) {
  for (const chatId of GROUP_CHAT_IDS) {
    try {
      await axios.post(
        `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text })
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
      );
    } catch (err) {
      console.log('Lỗi gửi tin nhắn tới nhóm', chatId, ':', err.response?.data || err.message);
    }
  }
}

// ------------------ New: inventory check & top change logic ------------------
let lastInventorySum = null;

async function checkInventorySumChange() {
  try {
    const token = await getAppAccessToken();
    if (!token) throw new Error('Không lấy được app access token');

    const values = await getAllSheetRows(token); // 2D array
    if (!values || values.length < 2) {
      console.log('Không có dữ liệu sheet hoặc thiếu header');
      return;
    }

    const headers = values[0].map(h => (h || '').toString().trim());
    const colInventoryIdx = headers.findIndex(h => h === '实时可售库存/Số lượng tồn kho' || h.toLowerCase().includes('实时可售库存'));
    if (colInventoryIdx === -1) {
      console.log('Không tìm thấy cột tồn kho (G) trong header:', headers.join(' | '));
      return;
    }

    // compute sum of column G
    let sum = 0;
    for (let i = 1; i < values.length; i++) {
      sum += _toNum(values[i][colInventoryIdx]);
    }

    console.log('Đã đổ số:', { current: String(sum), last: String(lastInventorySum) });

    if (lastInventorySum === null) {
      lastInventorySum = sum;
      return;
    }

    if (sum !== lastInventorySum) {
      // message 1
      const message1 = `🔹 Đã đổ số. Tổng tồn kho (cột G) hiện tại: ${sum}`;
      console.log('Gửi API tới BOT (notify):', { groups: GROUP_CHAT_IDS, message1 });
      await sendMessageToGroups(token, message1);

      // message 2: analyze and send top changes
      await sendTopChanges(token, values, headers);

      lastInventorySum = sum;
    }
  } catch (err) {
    console.log('Lỗi checkInventorySumChange:', err.response?.data || err.message || err);
  }
}

async function sendTopChanges(token, values, headers) {
  try {
    // If values/headers not provided, fetch them
    let vals = values;
    let hdr = headers;
    if (!vals || !hdr) {
      vals = await getAllSheetRows(token);
      if (!vals || vals.length < 2) return;
      hdr = vals[0].map(h => (h || '').toString().trim());
    } else {
      hdr = hdr.map(h => (h || '').toString().trim());
    }

    const findHeaderIndex = candidates => {
      const low = candidates.map(c => c.toString().trim().toLowerCase());
      for (let i = 0; i < hdr.length; i++) {
        const hh = (hdr[i] || '').toString().trim().toLowerCase();
        if (low.includes(hh)) return i;
        for (const c of low) if (hh.includes(c)) return i;
      }
      return -1;
    };

    const idxName = findHeaderIndex(['Product Name', 'product name']);
    const idxTotalSale = findHeaderIndex(['时间段内销量总计', '时间段内销量总计/tổng sale', '总 sale', 'tổng sale trong thời gian chọn']);
    const idxSale2 = findHeaderIndex(['前第2天销量', '前第2天销量/sale 2', 'sale 2']);
    const idxSale1 = findHeaderIndex(['昨日销量', '昨日销量/sale', 'sale ngày hôm qua', 'sale hôm qua']);

    if ([idxName, idxTotalSale, idxSale2, idxSale1].includes(-1)) {
      console.log('Thiếu một hoặc nhiều cột cần thiết:', { idxName, idxTotalSale, idxSale2, idxSale1 });
      await sendMessageToGroups(token, '❌ Không tìm thấy đầy đủ các cột cần thiết để phân tích Top SKU.');
      return;
    }

    const products = [];
    for (let i = 1; i < vals.length; i++) {
      const row = vals[i];
      const name = row[idxName] || '(NoName)';
      const totalSale = _toNum(row[idxTotalSale]);
      if (totalSale <= 100) continue;
      const o = _toNum(row[idxSale2]);
      const p = _toNum(row[idxSale1]);
      let ratio;
      if (o > 0) ratio = ((p - o) / o) * 100;
      else if (p > 0) ratio = Number.POSITIVE_INFINITY;
      else ratio = 0;
      products.push({ name: String(name).trim(), totalSale, o, p, ratio });
    }

    if (products.length === 0) {
      await sendMessageToGroups(token, 'Không có sản phẩm nào thỏa điều kiện (Tổng sale > 100).');
      return;
    }

    const topInc = [...products].sort((a, b) => {
      if (a.ratio === b.ratio) return 0;
      if (a.ratio === Number.POSITIVE_INFINITY) return -1;
      if (b.ratio === Number.POSITIVE_INFINITY) return 1;
      return b.ratio - a.ratio;
    }).slice(0, 5);

    const topDec = [...products].sort((a, b) => a.ratio - b.ratio).slice(0, 5);

    const fmt = p => (p.ratio === Number.POSITIVE_INFINITY ? `∞ (từ ${p.o} → ${p.p})` : `${p.ratio.toFixed(1)}% (từ ${p.o} → ${p.p})`);

    let message = `📊 Top biến động (lọc Tổng sale > 100):\n\n📈 Top 5 tăng mạnh nhất:\n`;
    topInc.forEach((p, i) => {
      message += `${i + 1}. ${p.name} — ${fmt(p)}\n`;
    });
    message += `\n📉 Top 5 giảm mạnh nhất:\n`;
    topDec.forEach((p, i) => {
      message += `${i + 1}. ${p.name} — ${fmt(p)}\n`;
    });

    await sendMessageToGroups(token, message);
  } catch (err) {
    console.log('Lỗi sendTopChanges:', err.response?.data || err.message || err);
    try { await sendMessageToGroups(token, `❌ Lỗi khi phân tích Top SKU: ${err.message || err}`); } catch {}
  }
}

// ------------------ rest of original handlers (unchanged) ------------------

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

    if (decryptedData && decryptedData.header && decryptedData.header.event_type === 'url_verification') {
      return res.json({ challenge: decryptedData.event.challenge });
    }

    if (decryptedData && decryptedData.header && decryptedData.header.event_type === 'im.message.receive_v1') {
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
          } catch (e) {
            console.log('Error processing post reply file:', e.response?.data || e.message || e);
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
        } catch (e) {
          console.log('Error text processing:', e.response?.data || e.message || e);
          await replyToLark(messageId, 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long', mentionUserId, mentionUserName);
        }
      } else {
        await replyToLark(messageId, 'Vui lòng sử dụng lệnh PUR, SALE, FIN, TEST kèm dấu phẩy và câu hỏi, hoặc gửi file/hình ảnh.', mentionUserId, mentionUserName);
      }
    }
  } catch (e) {
    console.log('Webhook processing error:', e.response?.data || e.message || e);
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
  } catch (e) {
    console.log('webhook-base error:', e.response?.data || e.message || e);
    res.status(500).send('Lỗi máy chủ nội bộ');
  }
});

app.listen(port, () => {
  // start inventory checker
  checkInventorySumChange();
  setInterval(checkInventorySumChange, 5 * 60 * 1000);
});

setInterval(() => {
  const now = Date.now();
  for (const [chatId, file] of pendingFiles) {
    if (now - file.timestamp > 5 * 60 * 1000) pendingFiles.delete(chatId);
  }
}, 60 * 1000);
