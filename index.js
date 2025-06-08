require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const Tesseract = require('tesseract.js');

const app = express();
app.use(express.json()); // Xử lý JSON webhook

// Kiểm tra biến môi trường
const requiredEnvVars = [
  'OPENROUTER_API_KEY',
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  'LARK_VERIFICATION_TOKEN',
  'LARK_ENCRYPT_KEY',
  'LARK_DOMAIN',
  'BOT_SENDER_ID',
];
const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.warn(`Missing environment variables: ${missingEnvVars.join(', ')}. Application may not function correctly.`);
}

// Kiểm tra LARK_ENCRYPT_KEY
if (process.env.LARK_ENCRYPT_KEY) {
  if (process.env.LARK_ENCRYPT_KEY.length !== 32) {
    console.error('Invalid LARK_ENCRYPT_KEY: Key must be exactly 32 characters');
  } else {
    console.log('LARK_ENCRYPT_KEY validated: 32 characters');
  }
}

// Tạo thư mục tạm
if (!fs.existsSync('temp_files')) {
  fs.mkdirSync('temp_files');
}

const processedMessageIds = new Set();
const conversationMemory = new Map();

function verifySignature(timestamp, nonce, body, signature) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  const raw = `${timestamp}${nonce}${encryptKey}${body}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return hash === signature;
}

function decryptMessage(encrypt) {
  try {
    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'utf-8');
    const aesKey = crypto.createHash('sha256').update(key).digest();
    const data = Buffer.from(encrypt, 'base64');
    const iv = data.slice(0, 16);
    const encryptedText = data.slice(16);
    console.log(`Decrypting with IV length: ${iv.length}, Ciphertext length: ${encryptedText.length}`);
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return JSON.parse(decrypted.toString());
  } catch (error) {
    console.error('Failed to decrypt webhook:', error.message, error.stack);
    return null;
  }
}

async function replyToLark(messageId, content) {
  try {
    const tokenResp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`, {
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
    console.log('[Webhook] Reply sent');
  } catch (err) {
    console.error('[Reply Error]', err?.response?.data || err.message);
  }
}

async function extractFileContent(fileUrl, fileType) {
  try {
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
      const sheetName = workbook.SheetNames[0];
      const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
      return sheet.map(row => row.join(' ')).join('\n');
    }

    if (['jpg', 'jpeg', 'png', 'bmp'].includes(fileType)) {
      const result = await Tesseract.recognize(buffer, 'eng+vie');
      return result.data.text.trim();
    }

    return '';
  } catch (error) {
    console.error(`[File Extraction Error] Type: ${fileType}`, error.message);
    return '';
  }
}

async function getAppAccessToken() {
  try {
    const resp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`, {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    });
    return resp.data.app_access_token;
  } catch (error) {
    console.error('[Token Error]', error?.response?.data || error.message);
    throw error;
  }
}

async function getAllTables(baseId, token) {
  try {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return resp.data.data.items;
  } catch (error) {
    console.error('[Base Tables Error]', error?.response?.data || error.message);
    return [];
  }
}

async function getAllRows(baseId, tableId, token) {
  const rows = [];
  let pageToken = '';
  try {
    do {
      const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=100&page_token=${pageToken}`;
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      rows.push(...resp.data.data.items);
      pageToken = resp.data.data.page_token || '';
    } while (pageToken);
    return rows;
  } catch (error) {
    console.error('[Base Rows Error]', error?.response?.data || error.message);
    return [];
  }
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

// Health check cho Railway
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).send('OK');
});

app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const bodyRaw = JSON.stringify(req.body);

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      console.error('[Webhook] Invalid signature');
      return res.status(401).send('Invalid signature');
    }

    const { encrypt } = req.body;
    if (!encrypt) {
      console.error('[Webhook] No encrypted data');
      return res.status(400).send('No encrypted data');
    }

    const decrypted = decryptMessage(encrypt);
    if (!decrypted) {
      console.error('[Webhook] Decryption failed');
      return res.status(400).send('Decryption failed');
    }
    console.log('[Webhook] Decrypted event:', JSON.stringify(decrypted, null, 2));

    if (decrypted.header.event_type === 'url_verification') {
      return res.json({ challenge: decrypted.event.challenge });
    }

    if (decrypted.header.event_type === 'im.message.receive_v1') {
      const senderId = decrypted.event.sender.sender_id.open_id;
      const message = decrypted.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const messageType = message.message_type;

      if (processedMessageIds.has(messageId)) return res.json({ code: 0 });
      processedMessageIds.add(messageId);

      if (senderId === process.env.BOT_SENDER_ID) return res.json({ code: 0 });

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
            tables = [
              {
                table_id: tableIdFromMsg,
                name: `Bảng theo ID: ${tableIdFromMsg}`,
                type: 'base_table',
              },
            ];
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

        return res.json({ code: 0 });
      }

      if (messageType === 'file' || messageType === 'image') {
        try {
          const fileKey = message.file_key;
          const fileName = message.file_name || `${messageId}.${messageType === 'image' ? 'jpg' : 'bin'}`;
          const ext = fileName.split('.').pop().toLowerCase();

          const fileUrlResp = await axios.get(
            `${process.env.LARK_DOMAIN}/open-apis/im/v1/files/${fileKey}/download_url`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const fileUrl = fileUrlResp.data.data.download_url;

          const extractedText = await extractFileContent(fileUrl, ext);

          if (extractedText.length === 0) {
            await replyToLark(messageId, 'Không thể trích xuất nội dung từ file này hoặc file trống.');
          } else {
            updateConversationMemory(chatId, 'user', `File ${fileName}: nội dung đã trích xuất.`);
            updateConversationMemory(chatId, 'assistant', extractedText);
            await replyToLark(messageId, `Nội dung file ${fileName}:\n${extractedText.slice(0, 1000)}${extractedText.length > 1000 ? '...' : ''}`);
          }
        } catch (e) {
          console.error('[File Processing Error]', e?.response?.data || e.message);
          await replyToLark(messageId, '❌ Lỗi khi xử lý file, vui lòng thử lại.');
        }
        return res.json({ code: 0 });
      }

      if (messageType === 'text' && userMessage.trim().length > 0) {
        updateConversationMemory(chatId, 'user', userMessage);

        try {
          const messages = conversationMemory.get(chatId).map(({ role, content }) => ({ role, content }));
          messages.unshift({ role: 'system', content: 'Bạn là một trợ lý AI thông minh, trả lời chính xác và hữu ích bằng tiếng Việt.' });
          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
              messages,
              stream: false,
              max_tokens: 1000,
              temperature: 0.7,
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
              },
            }
          );

          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, tôi không có câu trả lời.';
          updateConversationMemory(chatId, 'assistant', assistantMessage);
          await replyToLark(messageId, assistantMessage);
        } catch (e) {
          console.error('[AI Error]', e?.response?.data || e.message);
          await replyToLark(messageId, '❌ Lỗi khi gọi AI, vui lòng thử lại sau.');
        }

        return res.json({ code: 0 });
      }

      return res.json({ code: 0 });
    }

    return res.json({ code: 0 });
  } catch (e) {
    console.error('[Webhook Handler Error]', e);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`🚀 Smart Lark AI Bot running at http://localhost:${PORT}`);
});

// Xử lý graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Performing graceful shutdown...');
  server.close(() => {
    console.log('Server closed. Exiting process...');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Performing graceful shutdown...');
  server.close(() => {
    console.log('Server closed. Exiting process...');
    process.exit(0);
  });
});
