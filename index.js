import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware parse raw body để giải mã đúng encrypt
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Giải mã encrypt từ webhook Lark
function decryptEncryptKey(encryptStr, encryptKey) {
  const key = Buffer.from(encryptKey + '=', 'base64');
  const iv = key.slice(0, 16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);

  let decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptStr, 'base64')),
    decipher.final(),
  ]);

  const pad = decrypted[decrypted.length - 1];
  if (pad < 1 || pad > 16) throw new Error('Invalid padding');
  decrypted = decrypted.slice(0, decrypted.length - pad);

  const jsonLength = decrypted.readUInt32BE(16);
  const jsonPayload = decrypted.slice(20, 20 + jsonLength).toString();

  return JSON.parse(jsonPayload);
}

// Gọi OpenAI ChatGPT API
async function callOpenAI(message) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: message }],
      temperature: 0.7,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('OpenAI error:', data);
    throw new Error(data.error?.message || 'OpenAI API error');
  }
  return data.choices[0].message.content;
}

// Lấy Access Token app (App Access Token)
async function getAppAccessToken() {
  const res = await fetch('https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`Lark get token failed: ${data.msg}`);
  }
  return data.app_access_token;
}

app.post('/webhook', async (req, res) => {
  try {
    if (!req.body.encrypt) {
      console.log('Missing encrypt:', req.body);
      return res.status(400).send('Missing encrypt');
    }

    const decryptedEvent = decryptEncryptKey(req.body.encrypt, process.env.LARK_ENCRYPT_KEY);
    console.log('Decrypted event:', decryptedEvent);

    // Xác nhận URL challenge
    if (decryptedEvent?.challenge) {
      return res.status(200).send({ challenge: decryptedEvent.challenge });
    }

    if (decryptedEvent?.header?.event_type === 'im.message.receive_v1') {
      const userMessage = JSON.parse(decryptedEvent.event.message.content).text;
      console.log('User message:', userMessage);

      // Trả ngay 200 cho Lark webhook
      res.status(200).send({});

      // Gọi OpenAI
      const replyText = await callOpenAI(userMessage);

      // Lấy Access Token app
      const token = await getAppAccessToken();

      // Gửi message trả lời
      await fetch('https://open.larksuite.com/open-apis/im/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: decryptedEvent.event.sender.sender_id.open_id,
          content: JSON.stringify({ text: replyText }),
          msg_type: 'text',
        }),
      });
    } else {
      console.log('Không phải message event hoặc event_type khác:', decryptedEvent?.header?.event_type);
      res.status(200).send({});
    }
  } catch (error) {
    console.error('Webhook xử lý lỗi:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
