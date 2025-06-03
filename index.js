const express = require('express');
const bodyParser = require('body-parser');
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

app.use(bodyParser.json());

const chatHistories = new Map();
const processedMessageIds = new Set();

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
    const { data: { text } } = await Tesseract.recognize(buffer, 'eng+vie');
    return text.trim();
  }

  return '';
}

app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-lark-signature'];
  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  const body = JSON.stringify(req.body);

  if (!verifySignature(timestamp, nonce, body, signature)) {
    console.error('[Verify Signature] Invalid signature');
    return res.status(401).send('Invalid signature');
  }

  const { encrypt } = req.body;
  let decrypted;
  try {
    decrypted = decryptMessage(encrypt);
  } catch (e) {
    console.error('[Decrypt Error]', e);
    return res.status(400).send('Decrypt failed');
  }

  if (decrypted.header.event_type === 'url_verification') {
    return res.send({ challenge: decrypted.event.challenge });
  }

  if (decrypted.header.event_type === 'im.message.receive_v1') {
    const senderId = decrypted.event.sender.sender_id;
    const messageId = decrypted.event.message.message_id;
    const chatId = decrypted.event.message.chat_id;
    const chatType = decrypted.event.message.chat_type;
    const message = decrypted.event.message;
    const chatKey = chatType === 'p2p' ? `user_${senderId}` : `group_${chatId}`;

    console.log('[Debug] Sender ID:', senderId);

    if (processedMessageIds.has(messageId)) return res.send({ code: 0 });
    processedMessageIds.add(messageId);

    const BOT_SENDER_ID = process.env.BOT_SENDER_ID || '';
    if (senderId === BOT_SENDER_ID) return res.send({ code: 0 });

    let userMessage = '';
    try {
      const parsed = JSON.parse(message.content);
      userMessage = parsed.text || '';
    } catch (e) {}

    if (userMessage.includes('@all') || userMessage.includes('<at user_id="all">')) {
      return res.send({ code: 0 });
    }

    let extractedText = '';
    const fileKey = message?.file_key;
    const fileName = message?.file_name || '';

    if (fileKey) {
      try {
        const tokenResp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`, {
          app_id: process.env.LARK_APP_ID,
          app_secret: process.env.LARK_APP_SECRET,
        });
        const token = tokenResp.data.app_access_token;

        const fileResp = await axios.get(
          `${process.env.LARK_DOMAIN}/open-apis/drive/v1/files/${fileKey}/download_url`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        const url = fileResp.data.data.url;
        console.log('[Debug] File download URL:', url);

        const ext = fileName.split('.').pop().toLowerCase();

        try {
          extractedText = await extractFileContent(url, ext);
        } catch (e) {
          console.error('[Extract File Error]', e);
          extractedText = `[Lỗi đọc file: ${fileName}]`;
        }

        userMessage += `\n[Nội dung từ file "${fileName}"]:\n${extractedText}`;
      } catch (e) {
        console.error('[File Download URL Error]', e.response?.data || e.message);
        userMessage += `\n[Gặp lỗi khi lấy URL file: ${fileName}]`;
      }
    }

    // Giờ Việt Nam
    const now = new Date();
    now.setHours(now.getHours() + 7);
    const nowVN = now.toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour12: false,
    });

    if (!chatHistories.has(chatKey)) {
      chatHistories.set(chatKey, { messages: [], lastUpdated: Date.now() });
    }

    const current = chatHistories.get(chatKey);
    if (Date.now() - current.lastUpdated > 2 * 60 * 60 * 1000) {
      current.messages = [];
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
              content: `Bạn là một trợ lý AI thông minh. Trả lời ngắn gọn, rõ ràng, không sử dụng ký tự đặc biệt. Giờ Việt Nam hiện tại là: ${nowVN}`,
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
      console.error('[Chat Completion Error]', error.response?.data || error.message);
      await replyToLark(messageId, 'Xin lỗi, tôi gặp lỗi khi xử lý câu hỏi hoặc file của bạn.');
    }
  }

  res.send({ code: 0 });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
