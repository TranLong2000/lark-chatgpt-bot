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

const chatHistories = new Map();
const processedMessageIds = new Set();
const pendingFiles = new Map();

// Tạo thư mục nếu chưa có
fs.mkdirSync('temp_files', { recursive: true });
fs.mkdirSync('temp_images', { recursive: true });

// Tự dọn file cũ sau 2 giờ
setInterval(() => {
  const now = Date.now();
  fs.readdirSync('temp_files').forEach(file => {
    const filePath = path.join('temp_files', file);
    if (now - fs.statSync(filePath).mtimeMs > 2 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
    }
  });
  fs.readdirSync('temp_images').forEach(file => {
    const filePath = path.join('temp_images', file);
    if (now - fs.statSync(filePath).mtimeMs > 2 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
    }
  });
}, 60 * 60 * 1000); // mỗi giờ kiểm tra 1 lần

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
    const tempPath = path.join('temp_images', `img_${Date.now()}.${fileType}`);
    fs.writeFileSync(tempPath, buffer);
    const result = await Tesseract.recognize(tempPath, 'eng+vie');
    fs.unlinkSync(tempPath);
    return result.data.text.trim();
  }

  return '';
}

app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
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
      const sender = decrypted.event.sender.sender_id.open_id || decrypted.event.sender.sender_id.user_id;
      const messageId = decrypted.event.message.message_id;
      const chatId = decrypted.event.message.chat_id;
      const chatType = decrypted.event.message.chat_type;
      const message = decrypted.event.message;
      const messageType = message.message_type;
      const chatKey = chatType === 'p2p' ? `user_${sender}` : `group_${chatId}`;

      if (processedMessageIds.has(messageId)) {
        console.log('[Webhook] Duplicate messageId, ignoring:', messageId);
        return res.send({ code: 0 });
      }
      processedMessageIds.add(messageId);

      const BOT_SENDER_ID = process.env.BOT_SENDER_ID || '';
      if (sender === BOT_SENDER_ID) return res.send({ code: 0 });

      let userMessage = '';
      try {
        const parsed = JSON.parse(message.content);
        userMessage = parsed.text || '';
      } catch (e) {}

      if (userMessage.includes('@all') || userMessage.includes('<at user_id="all">')) {
        return res.send({ code: 0 });
      }

      const now = new Date();
      now.setHours(now.getHours() + 7);
      const nowVN = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

      if (!chatHistories.has(chatKey)) {
        chatHistories.set(chatKey, { messages: [], lastUpdated: Date.now() });
      }

      const current = chatHistories.get(chatKey);
      if (Date.now() - current.lastUpdated > 2 * 60 * 60 * 1000) {
        current.messages = [];
      }

      // Nếu là file đính kèm, lưu lại
      if (messageType === 'file') {
        try {
          const tokenResp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`, {
            app_id: process.env.LARK_APP_ID,
            app_secret: process.env.LARK_APP_SECRET,
          });
          const token = tokenResp.data.app_access_token;

          const fileResp = await axios.get(
            `${process.env.LARK_DOMAIN}/open-apis/drive/v1/files/${message.file_key}/download_url`,
            { headers: { Authorization: `Bearer ${token}` } }
          );

          const url = fileResp.data.data.url;
          const ext = message.file_name.split('.').pop().toLowerCase();
          pendingFiles.set(chatKey, {
            url,
            ext,
            name: message.file_name,
            timestamp: Date.now(),
          });

          console.log('[Webhook] File pending saved:', message.file_name);
          await replyToLark(messageId, `Đã nhận file "${message.file_name}". Hãy nhắn cho tôi để xử lý.`);
        } catch (e) {
          console.error('[File Error]', e.message);
          await replyToLark(messageId, `Lỗi khi tải file "${message.file_name}".`);
        }

        return res.send({ code: 0 });
      }

      // Nếu là tin nhắn, kiểm tra file đính kèm trước đó
      if (userMessage.trim().toLowerCase().includes('đọc')) {
        const fileInfo = pendingFiles.get(chatKey);
        if (fileInfo && Date.now() - fileInfo.timestamp < 10 * 60 * 1000) {
          try {
            const extracted = await extractFileContent(fileInfo.url, fileInfo.ext);
            userMessage += `\n[Nội dung từ file "${fileInfo.name}"]:\n${extracted}`;
          } catch (e) {
            userMessage += `\n[Gặp lỗi khi đọc file: ${fileInfo.name}]`;
            console.error('[OCR Error]', e.message);
          }
        }
      }

      current.messages.push({ role: 'user', content: userMessage });
      if (current.messages.length > 20) {
        current.messages.splice(0, current.messages.length - 20);
      }
      current.lastUpdated = Date.now();

      try {
        const chatResponse = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
            messages: [
              {
                role: 'system',
                content: `Bạn là một trợ lý AI thông minh. Trả lời ngắn gọn, rõ ràng, không dùng ký tự đặc biệt. Giờ Việt Nam hiện tại là: ${nowVN}`,
              },
              ...current.messages,
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
        current.messages.push({ role: 'assistant', content: reply });
        await replyToLark(messageId, reply);
      } catch (error) {
        console.error('[Chat Error]', error?.response?.data || error.message);
        await replyToLark(messageId, 'Xin lỗi, tôi gặp lỗi khi xử lý yêu cầu.');
      }
    }

    res.send({ code: 0 });
  } catch (err) {
    console.error('[Webhook] Handler error:', err.stack);
    res.status(500).send('Internal Error');
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
