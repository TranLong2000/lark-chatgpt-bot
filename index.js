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

// Bộ nhớ hội thoại theo chat_id, lưu trữ mảng message {role, content}, tự động xóa sau 2h
const conversationMemory = new Map();

if (!fs.existsSync('temp_files')) {
  fs.mkdirSync('temp_files');
}

// Middleware parse raw cho webhook
app.use('/webhook', express.raw({ type: '*/*' }));

function verifySignature(timestamp, nonce, body, signature) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  const raw = `${timestamp}${nonce}${encryptKey}${body}`;
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

// Lấy Access Token app nội bộ
async function getAppAccessToken() {
  const resp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`, {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  return resp.data.app_access_token;
}

// Lấy danh sách bảng trong Base
async function getAllTables(baseId, token) {
  const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.data.data.items; // mảng bảng
}

// Lấy dữ liệu toàn bộ bảng
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

// Cập nhật bộ nhớ hội thoại theo chat_id
function updateConversationMemory(chatId, role, content) {
  if (!conversationMemory.has(chatId)) {
    conversationMemory.set(chatId, []);
  }
  const mem = conversationMemory.get(chatId);
  mem.push({ role, content });
  // Giới hạn max 50 tin nhắn trong bộ nhớ để tránh quá lớn
  if (mem.length > 50) {
    mem.shift();
  }
}

// Xóa bộ nhớ cũ hơn 2h
// (Ở đây ta không xóa từng message, mà mỗi 2h clear toàn bộ bộ nhớ)
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
      console.error('[Webhook] Invalid signature');
      return res.status(401).send('Invalid signature');
    }

    const { encrypt } = JSON.parse(bodyRaw);
    const decrypted = decryptMessage(encrypt);
    console.log('[Webhook] Decrypted event:', JSON.stringify(decrypted, null, 2));

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

      // Nếu tin nhắn có chứa link Base muốn lấy dữ liệu (ví dụ dạng https://.../base/{baseId}?table=tblXXXX)
      // hoặc câu lệnh yêu cầu đọc Base
      const baseLinkMatch = userMessage.match(/https:\/\/[^\s]+\/base\/([a-zA-Z0-9]+)(?:\?table=([a-zA-Z0-9]+))?/);
      if (baseLinkMatch) {
        const baseId = baseLinkMatch[1];
        const tableId = baseLinkMatch[2]; // Có thể không có table id

        try {
          // Lấy danh sách bảng
          const tables = await getAllTables(baseId, token);

          let baseSummary = `Dữ liệu Base ID: ${baseId}\n`;

          // Duyệt tất cả bảng
          for (const table of tables) {
            if (table.type === 'base_table') {
              baseSummary += `\nBảng: ${table.name} (ID: ${table.table_id})\n`;

              const rows = await getAllRows(baseId, table.table_id, token);

              if (rows.length === 0) {
                baseSummary += '  (Không có bản ghi)\n';
                continue;
              }

              // Lấy tối đa 10 bản ghi đầu để tránh quá dài
              const sampleRows = rows.slice(0, 10);

              for (const row of sampleRows) {
                // row.fields là đối tượng key:value chứa dữ liệu từng trường
                const fieldsText = Object.entries(row.fields).map(([k, v]) => `${k}: ${v}`).join('; ');
                baseSummary += `  - ${fieldsText}\n`;
              }
              if (rows.length > 10) baseSummary += `  ... (${rows.length} bản ghi)\n`;
            }
          }

          // Cập nhật bộ nhớ hội thoại
          updateConversationMemory(chatId, 'user', userMessage);
          updateConversationMemory(chatId, 'assistant', baseSummary);

          await replyToLark(messageId, baseSummary);
        } catch (e) {
          console.error('[Base API Error]', e?.response?.data || e.message);
          await replyToLark(messageId, '❌ Lỗi khi truy xuất Base, vui lòng kiểm tra quyền hoặc thử lại sau.');
        }

        return res.send({ code: 0 });
      }

      // Xử lý file hoặc ảnh
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

          pendingFiles.set(messageId, {
            url,
            ext,
            name: fileName,
            timestamp: Date.now(),
          });

          await replyToLark(messageId, '✅ Đã lưu file. Vui lòng *reply* vào tin nhắn này để tôi đọc nội dung.');
        } catch (e) {
          console.error('[File/Image Error]', e.message);
          await replyToLark(messageId, '❌ Gặp lỗi khi tải file hoặc ảnh. Vui lòng thử lại.');
        }

        return res.send({ code: 0 });
      }

      // Xử lý reply vào file
      if (messageType === 'text' && message.parent_id) {
        const fileInfo = pendingFiles.get(message.parent_id);
        if (!fileInfo) {
          await replyToLark(messageId, '⚠️ Không tìm thấy file tương ứng. Vui lòng gửi file rồi reply lại.');
          return res.send({ code: 0 });
        }

        try {
          const extractedText = await extractFileContent(fileInfo.url, fileInfo.ext);
          const combinedMessage = userMessage + '\n\n[Nội dung file "' + fileInfo.name + '"]:\n' + extractedText;

          // Lưu bộ nhớ hội thoại
          updateConversationMemory(chatId, 'user', combinedMessage);

          const now = new Date();
          now.setHours(now.getHours() + 7);
          const nowVN = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

          const chatResponse = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
              messages: [
                {
                  role: 'system',
                  content: `Bạn là trợ lý AI. Trả lời ngắn gọn, rõ ràng. Giờ Việt Nam hiện tại là: ${nowVN}`,
                },
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

          // Lưu câu trả lời AI vào bộ nhớ
          updateConversationMemory(chatId, 'assistant', reply);

          await replyToLark(messageId, reply);
        } catch (err) {
          console.error('[Extract/Chat Error]', err?.response?.data || err.message);
          await replyToLark(messageId, '❌ Lỗi khi đọc file hoặc xử lý AI. Vui lòng thử lại.');
        }

        return res.send({ code: 0 });
      }

      // Xử lý mention bot trong tin nhắn text
      const mentionKey = message.mentions?.[0]?.key;
      if (messageType === 'text' && mentionKey?.includes('_user_')) {
        // Lưu user message vào bộ nhớ
        updateConversationMemory(chatId, 'user', userMessage);

        const now = new Date();
        now.setHours(now.getHours() + 7);
        const nowVN = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

        const chatResponse = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
            messages: [
              {
                role: 'system',
                content: `Bạn là trợ lý AI. Trả lời ngắn gọn, rõ ràng. Giờ Việt Nam hiện tại là: ${nowVN}`,
              },
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
    }

    res.send({ code: 0 });
  } catch (e) {
    console.error('[Webhook Error]', e.message);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Bot Lark running on port ${port}`);
});
