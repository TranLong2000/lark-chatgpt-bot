const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

console.log('OPENROUTER_API_KEY:', process.env.OPENROUTER_API_KEY ? 'FOUND' : 'NOT FOUND');
console.log('OPENROUTER_API_KEY value:', process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.substring(0, 8) + '...' : 'undefined');

app.use(bodyParser.json());

// Bộ nhớ lưu lịch sử chat, key là user_id, value là mảng message
const chatHistories = {};

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
    const appAccessTokenResp = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`,
      {
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }
    );
    const token = appAccessTokenResp.data.app_access_token;

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

app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-lark-signature'];
  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  const body = JSON.stringify(req.body);

  console.log('\n--- New Webhook Request ---');
  console.log('Headers:', req.headers);
  console.log('Body:', body);

  if (!verifySignature(timestamp, nonce, body, signature)) {
    console.warn('[Webhook] Invalid signature – stop.');
    return res.status(401).send('Invalid signature');
  }

  const { encrypt } = req.body;
  const decrypted = decryptMessage(encrypt);

  if (decrypted.header.event_type === 'url_verification') {
    return res.send({ challenge: decrypted.event.challenge });
  }

  if (decrypted.header.event_type === 'im.message.receive_v1') {
    const senderId = decrypted.event.sender.sender_id;
    const userId = decrypted.event.sender.user_id; // user id riêng biệt
    console.log('Sender ID:', senderId);
    console.log('User ID:', userId);

    // Tránh bot trả lời chính nó
    const BOT_SENDER_ID = process.env.BOT_SENDER_ID || 'YOUR_BOT_SENDER_ID';
    if (senderId === BOT_SENDER_ID) {
      console.log('Tin nhắn từ bot, bỏ qua để tránh vòng lặp.');
      return res.send({ code: 0 });
    }

    const messageText = decrypted.event.message.content;
    const messageId = decrypted.event.message.message_id;

    try {
      const parsedContent = JSON.parse(messageText);
      const userMessage = parsedContent.text;

      // Khởi tạo lịch sử chat nếu chưa có
      if (!chatHistories[userId]) {
        chatHistories[userId] = [];
      }

      // Thêm tin nhắn người dùng vào lịch sử
      chatHistories[userId].push({ role: 'user', content: userMessage });

      // Giới hạn lịch sử chat chỉ giữ tối đa 10 câu hỏi để tránh quá dài
      if (chatHistories[userId].length > 20) {
        chatHistories[userId].splice(0, chatHistories[userId].length - 20);
      }

      // Gọi OpenRouter API với lịch sử chat
      const chatResponse = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'openai/gpt-3.5-turbo',
          messages: chatHistories[userId],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const reply = chatResponse.data.choices[0].message.content;

      // Thêm câu trả lời bot vào lịch sử
      chatHistories[userId].push({ role: 'assistant', content: reply });

      await replyToLark(messageId, reply);
    } catch (error) {
      console.error('[OpenRouter Error]', error.message);
      if (error.response) {
        console.error('Response data:', error.response.data);
        console.error('Response status:', error.response.status);
        console.error('Response headers:', error.response.headers);
      }
      await replyToLark(messageId, 'Xin lỗi, có lỗi xảy ra khi xử lý tin nhắn của bạn.');
    }
  }

  res.send({ code: 0 });
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
