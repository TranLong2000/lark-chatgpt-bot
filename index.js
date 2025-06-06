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
const port = process.env.PORT || 3000;

const processedMessageIds = new Set();
const pendingFiles = new Map();
const conversationMemory = new Map();

if (!fs.existsSync('temp_files')) {
  fs.mkdirSync('temp_files');
}

app.use('/webhook', express.raw({ type: '*/*' }));

function verifySignature(timestamp, nonce, body, signature) {
  const raw = `${timestamp}${nonce}${process.env.LARK_ENCRYPT_KEY}${body}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
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

async function replyToLark(messageId, content) {
  try {
    const tokenResp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`, {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    });
    const token = tokenResp.data.app_access_token;

    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages/${messageId}/reply`,
      {
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('[Reply Error]', err?.response?.data || err.message);
  }
}

async function extractFileContent(fileUrl, fileType) {
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
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
    const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
    return sheet.map(row => row.join(' ')).join('\n');
  }

  if (['jpg', 'jpeg', 'png', 'bmp'].includes(fileType)) {
    const result = await Tesseract.recognize(buffer, 'eng+vie');
    return result.data.text.trim();
  }

  return '';
}

async function getAppAccessToken() {
  const resp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`, {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  return resp.data.app_access_token;
}

async function getAllTables(baseId, token) {
  const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.data.data.items;
}

async function getAllRows(baseId, tableId, token) {
  const rows = [];
  let pageToken = '';
  do {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=100&page_token=${pageToken}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    rows.push(...resp.data.data.items);
    pageToken = resp.data.data.page_token || '';
  } while (pageToken);
  return rows;
}

function updateConversationMemory(chatId, role, content) {
  if (!conversationMemory.has(chatId)) {
    conversationMemory.set(chatId, []);
  }
  const mem = conversationMemory.get(chatId);
  mem.push({ role, content });
  if (mem.length > 50) mem.shift();
}

setInterval(() => {
  conversationMemory.clear();
  console.log('[Memory] Cleared conversation memory (2h interval)');
}, 2 * 60 * 60 * 1000);

app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const bodyRaw = req.body.toString();

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      return res.status(401).send('Invalid signature');
    }

    const { encrypt } = JSON.parse(bodyRaw);
    const decrypted = decryptMessage(encrypt);

    if (decrypted.header.event_type === 'url_verification') {
      return res.send({ challenge: decrypted.event.challenge });
    }

    if (decrypted.header.event_type === 'im.message.receive_v1') {
      const senderId = decrypted.event.sender.sender_id.open_id;
      const message = decrypted.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const chatType = message.chat_type;
      const messageType = message.message_type;

      if (processedMessageIds.has(messageId)) return res.send({ code: 0 });
      processedMessageIds.add(messageId);
      if (senderId === (process.env.BOT_SENDER_ID || '')) return res.send({ code: 0 });

      let userMessage = '';
      try {
        const parsed = JSON.parse(message.content);
        userMessage = parsed.text || '';
      } catch {}

      const token = await getAppAccessToken();

      const baseId = process.env.LARK_BASE_ID || '';
      const baseLinkMatch = userMessage.match(/https:\/\/[^\s]+\/base\/([a-zA-Z0-9]+)(?:\?table=([a-zA-Z0-9]+))?/);
      const explicitTableIdMatch = userMessage.match(/tbl61rgzOwS8viB2/);

      if (baseLinkMatch || explicitTableIdMatch) {
        const baseIdFromMsg = baseLinkMatch ? baseLinkMatch[1] : baseId;
        const tableIdFromMsg = baseLinkMatch ? baseLinkMatch[2] : 'tbl61rgzOwS8viB2';

        try {
          let tables = [];
          if (tableIdFromMsg) {
            tables = [{ table_id: tableIdFromMsg, name: `Bảng theo ID: ${tableIdFromMsg}`, type: 'base_table' }];
          } else {
            tables = await getAllTables(baseIdFromMsg, token);
          }

          let baseSummary = `Dữ liệu Base ID: ${baseIdFromMsg}\n`;
          for (const table of tables) {
            if (table.type === 'base_table') {
              baseSummary += `\nBảng: ${table.name} (ID: ${table.table_id})\n`;
              const rows = await getAllRows(baseIdFromMsg, table.table_id, token);
              if (rows.length === 0) {
                baseSummary += '  (Không có bản ghi)\n';
                continue;
              }
              const sampleRows = rows.slice(0, 10);
              for (const row of sampleRows) {
                const fieldsText = Object.entries(row.fields).map(([k, v]) => `${k}: ${v}`).join('; ');
                baseSummary += `  - ${fieldsText}\n`;
              }
              if (rows.length > 10) baseSummary += `  ... (${rows.length} bản ghi)\n`;
            }
          }

          updateConversationMemory(chatId, 'user', userMessage);
          updateConversationMemory(chatId, 'assistant', baseSummary);
          await replyToLark(messageId, baseSummary);
        } catch (e) {
          console.error('[Base API Error]', e?.response?.data || e.message);
          await replyToLark(messageId, '❌ Lỗi khi truy xuất Base, vui lòng kiểm tra quyền hoặc thử lại sau.');
        }

        return res.send({ code: 0 });
      }

      if (messageType === 'file' || messageType === 'image') {
        try {
          const fileKey = message.file_key;
          const fileName = message.file_name || `${messageId}.${messageType === 'image' ? 'jpg' : 'bin'}`;
          const ext = fileName.split('.').pop().toLowerCase();

          const fileResp = await axios.get(
            `${process.env.LARK_DOMAIN}/open-apis/drive/v1/files/${fileKey}/download_url`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          const url = fileResp.data.data.url;
          pendingFiles.set(messageId, { url, ext, name: fileName, timestamp: Date.now() });
          await replyToLark(messageId, '✅ Đã lưu file. Vui lòng *reply* vào tin nhắn này để tôi đọc nội dung.');
        } catch (e) {
          await replyToLark(messageId, '❌ Gặp lỗi khi tải file hoặc ảnh. Vui lòng thử lại.');
        }

        return res.send({ code: 0 });
      }

      if (messageType === 'text' && message.parent_id) {
        const fileInfo = pendingFiles.get(message.parent_id);
        if (!fileInfo) {
          await replyToLark(messageId, '⚠️ Không tìm thấy file tương ứng. Vui lòng gửi file rồi reply lại.');
          return res.send({ code: 0 });
        }

        try {
          const extractedText = await extractFileContent(fileInfo.url, fileInfo.ext);
          const combinedMessage = userMessage + '\n\n[Nội dung file "' + fileInfo.name + '"]:\n' + extractedText;

          updateConversationMemory(chatId, 'user', combinedMessage);

          const now = new Date(); now.setHours(now.getHours() + 7);
          const nowVN = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

          const chatResponse = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
              messages: [
                { role: 'system', content: `Bạn là trợ lý AI. Giờ Việt Nam hiện tại là: ${nowVN}` },
                ...conversationMemory.get(chatId) || [],
              ],
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
              },
            }
          );

          const reply = chatResponse.data.choices[0].message.content;
          updateConversationMemory(chatId, 'assistant', reply);
          await replyToLark(messageId, reply);
        } catch (err) {
          await replyToLark(messageId, '❌ Lỗi khi đọc file hoặc xử lý AI. Vui lòng thử lại.');
        }

        return res.send({ code: 0 });
      }

      if (messageType === 'text' && userMessage.includes('@')) {
        const now = new Date(); now.setHours(now.getHours() + 7);
        const nowVN = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

        updateConversationMemory(chatId, 'user', userMessage);

        const chatResponse = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
            messages: [
              { role: 'system', content: `Bạn là trợ lý AI. Giờ Việt Nam hiện tại là: ${nowVN}` },
              ...conversationMemory.get(chatId) || [],
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );

        const reply = chatResponse.data.choices[0].message.content;
        updateConversationMemory(chatId, 'assistant', reply);
        await replyToLark(messageId, reply);
        return res.send({ code: 0 });
      }

      return res.send({ code: 0 });
    }

    return res.send({ code: 0 });
  } catch (error) {
    console.error('[Webhook Error]', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Bot listening on port ${port}`);
});
