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

const processedMessageIds = new Set();
const conversationMemory = new Map();

if (!fs.existsSync('temp_files')) {
  fs.mkdirSync('temp_files');
}

app.use('/webhook', express.raw({ type: '*/*' }));

function verifySignature(timestamp, nonce, body, signature) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  if (!encryptKey) {
    console.error('[VerifySignature] LARK_ENCRYPT_KEY is not set');
    return false;
  }
  const raw = `${timestamp}${nonce}${encryptKey}${body}`;
  console.log('[VerifySignature] Input:', { timestamp, nonce, bodyLength: body.length, signature });
  console.log('[VerifySignature] Raw string:', raw);
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  console.log('[VerifySignature] Generated hash:', hash);
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
}

async function extractImageContent(imageData) {
  const result = await Tesseract.recognize(imageData, 'eng+vie');
  return result.data.text.trim();
}

async function getAppAccessToken() {
  const resp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`, {
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
    const bodyRaw = req.body.toString('utf8');

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      console.error('[Webhook] Invalid signature');
      return res.status(401).send('Invalid signature');
    }

    const { encrypt } = JSON.parse(bodyRaw);
    const decrypted = decryptMessage(encrypt);
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

        return res.send({ code: 0 });
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
        return res.send({ code: 0 });
      }

      if (messageType === 'post') {
        try {
          const parsedContent = JSON.parse(message.content);
          let textContent = '';
          let imageKey = '';

          // Trích xuất văn bản và image_key từ content
          for (const block of parsedContent.content) {
            for (const item of block) {
              if (item.tag === 'text') {
                textContent += item.text + ' ';
              } else if (item.tag === 'img') {
                imageKey = item.image_key;
              }
            }
          }
          textContent = textContent.trim();

          let extractedText = '';
          if (imageKey) {
            // Lấy dữ liệu binary của hình ảnh
            console.log('[Post] Fetching image with key:', imageKey);
            const imageResp = await axios.get(
              `${process.env.LARK_DOMAIN}/open-apis/im/v1/images/${imageKey}`,
              { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' }
            );
            console.log('[Post] Image response content-type:', imageResp.headers['content-type']);
            const imageData = Buffer.from(imageResp.data);

            // Trích xuất văn bản từ hình ảnh
            extractedText = await extractImageContent(imageData);
            console.log('[Post] Extracted text from image:', extractedText);
          }

          // Kết hợp văn bản từ tin nhắn và hình ảnh
          const combinedMessage = textContent + (extractedText ? `\nNội dung trích xuất từ hình ảnh: ${extractedText}` : '');

          if (combinedMessage.length === 0) {
            await replyToLark(messageId, 'Không thể trích xuất nội dung từ tin nhắn hoặc hình ảnh.');
            return res.send({ code: 0 });
          }

          // Cập nhật bộ nhớ hội thoại
          updateConversationMemory(chatId, 'user', combinedMessage);

          // Gửi đến API AI
          const messages = conversationMemory.get(chatId).map(({ role, content }) => ({ role, content }));
          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
              messages,
              stream: false,
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

          return res.send({ code: 0 });
        } catch (e) {
          console.error('[Post Processing Error]', {
            code: e?.response?.data?.code,
            message: e?.response?.data?.msg || e.message,
            status: e?.response?.status,
          });
          await replyToLark(messageId, '❌ Lỗi khi xử lý tin nhắn post, vui lòng kiểm tra quyền truy cập hình ảnh hoặc thử lại.');
          return res.send({ code: 0 });
        }
      }

      if (messageType === 'text' && userMessage.trim().length > 0) {
        updateConversationMemory(chatId, 'user', userMessage);

        try {
          const messages = conversationMemory.get(chatId).map(({ role, content }) => ({ role, content }));
          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
              messages,
              stream: false,
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

        return res.send({ code: 0 });
      }

      return res.send({ code: 0 });
    }

    return res.send({ code: 0 });
  } catch (e) {
    console.error('[Webhook Handler Error]', e);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
