const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Cache đơn giản lưu message_id đã xử lý (lưu trong RAM, restart mất)
const processedMessages = new Set();

app.use(bodyParser.json());

// Debug biến môi trường
console.log('OPENROUTER_API_KEY:', process.env.OPENROUTER_API_KEY ? 'FOUND' : 'NOT FOUND');
console.log('OPENROUTER_API_KEY value:', process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.substring(0, 8) + '...' : 'undefined');

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
    // Lấy app_access_token nội bộ
    const appAccessTokenResp = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`,
      {
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }
    );
    const token = appAccessTokenResp.data.app_access_token;

    // Gửi tin nhắn trả lời
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
    const messageId = decrypted.event.message.message_id;

    // Trả về nhanh để tránh Lark gửi lại webhook
    res.send({ code: 0 });

    // Bỏ qua nếu đã xử lý message này rồi
    if (processedMessages.has(messageId)) {
      console.log(`[Webhook] Message ${messageId} đã xử lý, bỏ qua.`);
      return;
    }

    // Bỏ qua tin nhắn do BOT gửi (đặt BOT_SENDER_ID trong .env)
    const senderId = decrypted.event.sender?.sender_id || '';
    if (senderId === process.env.BOT_SENDER_ID) {
      console.log('[Webhook] Tin nhắn do BOT gửi, bỏ qua.');
      return;
    }

    processedMessages.add(messageId);

    try {
      const messageText = decrypted.event.message.content;
      const parsedContent = JSON.parse(messageText);
      const userMessage = parsedContent.text;

      if (!userMessage || userMessage.trim() === '') {
        await replyToLark(messageId, 'Bạn chưa nhập nội dung tin nhắn.');
        return;
      }

      // Gọi OpenRouter API trả lời
      const chatResponse = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'openai/gpt-3.5-turbo',
          messages: [{ role: 'user', content: userMessage }],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const reply = chatResponse.data.choices[0].message.content;
      await replyToLark(messageId, reply);

    } catch (error) {
      console.error('[OpenRouter Error]', error.message);

      // Chỉ gửi 1 lần tin nhắn lỗi, không retry
      await replyToLark(messageId, 'Xin lỗi, hiện tại bot gặp lỗi, vui lòng thử lại sau.');
    }
  } else {
    // Trả về cho các event khác
    res.send({ code: 0 });
  }
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
