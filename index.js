const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const Tesseract = require('tesseract.js');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

// Cập nhật ánh xạ Base
const BASE_MAPPINGS = {
  'PUR': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbl61rgzOwS8viB2&view=vewi5cxZif',
  'SALE': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tblClioOV3nPN6jM&view=vew7RMyPed',
  'FIN': 'https://cgfscmkep8m.sg.larksuite.com/base/Um8Zb07ayaDFAws9BRFlbZtngZf?table=tblc0IuDKdYrVGqo&view=vewU8BLeBr',
  'TEST': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbllwXLQBdRgex9z&view=vewksBlcon'
};

// Thêm ánh xạ cho Lark Sheet
const SHEET_MAPPINGS = {
  'PUR_SHEET': 'https://cgfscmkep8m.sg.larksuite.com/sheets/Qd5JsUX0ehhqO9thXcGlyAIYg9g?sheet=6eGZ0D'
};

const processedMessageIds = new Set();
const conversationMemory = new Map();
const pendingTasks = new Map();
const pendingFiles = new Map();

if (!fs.existsSync('temp_files')) {
  fs.mkdirSync('temp_files');
}

app.use('/webhook', express.raw({ type: '*/*' }));

function verifySignature(timestamp, nonce, body, signature) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  if (!encryptKey) {
    console.error('[VerifySignature] LARK_ENCRYPT_KEY chưa được thiết lập');
    return false;
  }
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
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
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
      messageContent = {
        text: `${content} <at user_id="${mentionUserId}">${mentionUserName}</at>`,
      };
    } else {
      messageContent = { text: content };
    }

    const response = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages/${messageId}/reply`,
      {
        msg_type: msgType,
        content: JSON.stringify(messageContent),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
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
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
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
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    });
    return resp.data.data.fields.map(field => ({
      name: field.name,
      field_id: field.field_id,
    }));
  } catch (err) {
    console.error('[getTableMeta Error] Nguyên nhân:', err.response?.data || err.message);
    return [];
  }
}

async function getAllRows(baseId, tableId, token, requiredFields = []) {
  const rows = [];
  let pageToken = '';
  do {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=20&page_token=${pageToken}`;
    try {
      console.log('[getAllRows] Đang lấy dữ liệu, số dòng hiện tại:', rows.length, 'cho baseId:', baseId, 'tableId:', tableId, 'Fields:', requiredFields);
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: requiredFields.length > 0 ? { field_names: requiredFields.join(',') } : {},
        timeout: 20000,
      });
      if (!resp.data || !resp.data.data) {
        console.error('[getAllRows] Phản hồi API không hợp lệ:', JSON.stringify(resp.data));
        break;
      }
      rows.push(...(resp.data.data.items || []));
      pageToken = resp.data.data.page_token || '';
    } catch (e) {
      console.error('[getAllRows] Lỗi:', e.response?.data || e.message);
      break;
    }
  } while (pageToken && rows.length < 100); // Giới hạn tối đa 100 dòng
  console.log('[getAllRows] Tổng số dòng lấy được:', rows.length, 'Dữ liệu mẫu:', JSON.stringify(rows.slice(0, 5))); // Hiển thị 5 dòng mẫu
  return rows;
}

async function getSheetData(spreadsheetToken, token, range = 'A:Z') {
  const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`;
  console.log('[getSheetData] Gọi API với URL:', url);
  try {
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    });
    return resp.data.data.valueRange.values || [];
  } catch (err) {
    console.error('[getSheetData Error]', err?.response?.data || err.message);
    return [];
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
    // Lấy metadata của bảng để xác định cột
    const fields = await getTableMeta(baseId, tableId, token);
    console.log('[Debug] Các cột trong bảng:', fields.map(f => f.name));

    // Lấy tất cả dữ liệu mà không chỉ định trường
    const rows = await getAllRows(baseId, tableId, token);
    const allRows = rows.map(row => row.fields || {});

    if (!allRows || allRows.length === 0) {
      return { result: 'Không có dữ liệu trong Base' };
    }

    const validRows = allRows.filter(row => row && typeof row === 'object');
    if (validRows.length === 0) {
      return { result: 'Không có hàng hợp lệ' };
    }

    // Ánh xạ cột dựa trên từ khóa
    const monthCol = fields.find(f => ['month', 'tháng'].some(k => f.name.toLowerCase().includes(k)))?.name || 'Month';
    const valueCol = fields.find(f => ['po', 'số po', 'count po'].some(k => f.name.toLowerCase().includes(k)))?.name || 'Count PO';
    console.log('[Debug] Cột Month:', monthCol, 'Cột Value:', valueCol);

    // Debug: Hiển thị tất cả giá trị Month
    const monthValues = validRows.map(row => row[monthCol] ? row[monthCol].toString().trim() : 'null');
    console.log('[Debug] Giá trị Month trong dữ liệu:', monthValues);

    // Lọc dữ liệu cho tháng 11/2023
    const monthMatch = userMessage.match(/tháng\s*(\d{1,2})\/(\d{4})/i);
    let targetMonth = '11/2023'; // Mặc định theo yêu cầu
    if (monthMatch) {
      const month = monthMatch[1].padStart(2, '0');
      const year = monthMatch[2];
      targetMonth = `${month}/${year}`;
    }

    const filteredRows = validRows.filter(row => {
      const month = row[monthCol];
      let monthValue = month ? month.toString().trim() : null;
      if (monthValue && monthValue.toLowerCase().startsWith('tháng')) {
        monthValue = monthValue.replace(/tháng/i, '').trim();
      }
      if (monthValue && !monthValue.includes('/')) {
        monthValue = `0${monthValue}/2024`;
      }
      console.log('[Debug] So sánh Month:', monthValue, 'với target:', targetMonth);
      return monthValue && monthValue === targetMonth;
    });

    if (filteredRows.length === 0) {
      return { result: `Không có dữ liệu cho tháng ${targetMonth}` };
    }

    // Tính tổng Count PO
    const total = filteredRows.reduce((sum, row) => sum + (parseFloat(row[valueCol]) || 0), 0);
    console.log('[Debug] Dữ liệu lọc được:', JSON.stringify(filteredRows));
    return { result: `Tổng ${valueCol} của ${targetMonth} là ${total}` };
  } catch (e) {
    console.error('[Analysis Error] Nguyên nhân:', e.message);
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
    console.error('[Base API Error] Nguyên nhân:', e?.response?.data || e.message);
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
    const headers = sheetData[0] || []; // Dòng đầu tiên là tiêu đề
    const rows = sheetData.slice(1).map(row => row.map(cell => cell || ''));

    // Tìm cột Month và Count PO
    const monthColIndex = headers.findIndex(header => header && ['month', 'tháng'].some(k => header.toLowerCase().includes(k)));
    const poColIndex = headers.findIndex(header => header && ['po', 'số po', 'count po'].some(k => header.toLowerCase().includes(k)));

    if (monthColIndex === -1 || poColIndex === -1) {
      await replyToLark(messageId, 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long', mentionUserId, mentionUserName);
      return;
    }

    // Lọc dữ liệu cho tháng 6/2025
    const targetMonth = '06/2025';
    const filteredRows = rows.filter(row => {
      const month = row[monthColIndex];
      return month && month === targetMonth;
    });

    if (filteredRows.length === 0) {
      await replyToLark(messageId, 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long', mentionUserId, mentionUserName);
      return;
    }

    let totalPO = 0;
    filteredRows.forEach(row => {
      const poValue = parseFloat(row[poColIndex]) || 0;
      totalPO += poValue;
    });

    const response = `Tổng số PO của tháng ${targetMonth} là ${totalPO}`;
    updateConversationMemory(chatId, 'user', userMessage);
    updateConversationMemory(chatId, 'assistant', response);
    await replyToLark(messageId, response, mentionUserId, mentionUserName);
  } catch (e) {
    console.error('[Sheet API Error] Nguyên nhân:', e?.response?.data || err.message);
    await replyToLark(messageId, 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long', mentionUserId, mentionUserName);
  } finally {
    pendingTasks.delete(messageId);
  }
}

// Xử lý tín hiệu dừng
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
  let bodyRaw = req.body.toString('utf8');
  try {
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      console.error('[Webhook] Chữ ký không hợp lệ, kiểm tra LARK_ENCRYPT_KEY. Request Body:', bodyRaw);
      return res.status(401).send('Chữ ký không hợp lệ');
    }

    const { encrypt } = JSON.parse(bodyRaw);
    const decrypted = decryptMessage(encrypt);

    console.log('[Webhook Debug] Received event_type:', decrypted.header.event_type, 'Full Decrypted:', JSON.stringify(decrypted));

    if (decrypted.header.event_type === 'url_verification') {
      return res.json({ challenge: decrypted.event.challenge });
    }

    if (decrypted.header.event_type === 'im.message.receive_v1') {
      const senderId = decrypted.event.sender.sender_id.open_id;
      const message = decrypted.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const messageType = message.message_type;
      const parentId = message.parent_id;
      const mentions = message.mentions || [];

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

      console.log('[Message Debug] chatId:', chatId, 'messageId:', messageId, 'parentId:', parentId, 'messageType:', messageType, 'Full Message:', JSON.stringify(message));
      console.log('[Mentions Debug] Mentions:', JSON.stringify(mentions, null, 2));

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
    console.error('[Webhook Handler Error] Nguyên nhân:', e.message, 'Request Body:', bodyRaw || 'Không có dữ liệu');
    res.status(500).send('Lỗi máy chủ nội bộ');
  }
});

// Gọi hàm logBotOpenId khi server khởi động
logBotOpenId().then(() => {
  app.listen(port, () => {
    console.log(`Máy chủ đang chạy trên cổng ${port}`);
  });
});

// Xóa file trong pendingFiles sau 5 phút nếu không có reply
setInterval(() => {
  const now = Date.now();
  for (const [chatId, file] of pendingFiles) {
    if (now - file.timestamp > 5 * 60 * 1000) {
      console.log('[Cleanup] Xóa file từ pendingFiles do hết thời gian:', chatId, file.fileName);
      pendingFiles.delete(chatId);
    }
  }
}, 60 * 1000);
