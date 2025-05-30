import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fetch from 'node-fetch'; // nếu chưa cài: npm install node-fetch@2
import { Configuration, OpenAIApi } from 'openai';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Giải mã dữ liệu encrypt từ Lark
function decryptLarkData(encrypt) {
  const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'utf8');
  if (key.length !== 32) {
    throw new Error(`Invalid LARK_ENCRYPT_KEY length ${key.length}, must be 32`);
  }

  const encryptedData = Buffer.from(encrypt, 'base64');
  const iv = encryptedData.subarray(0, 16);
  const ciphertext = encryptedData.subarray(16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(true);

  let decrypted = decipher.update(ciphertext, null, 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}

// Lấy access token app Lark (App Access Token)
async function getAccessToken() {
  const url = 'https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal/';
  const body = {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data || data.code !== 0) {
    throw new Error('Lấy access token thất bại: ' + JSON.stringify(data));
  }
  return data.app_access_token;
}

// Gửi tin nhắn trả lời qua API Lark Chat
async function sendReplyMessage(chat_id, text, token) {
  const url = 'https://open.larksuite.com/open-apis/message/v4/send/';
  const body = {
    chat_id,
    msg_type: 'text',
    content: JSON.stringify({ text }),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data || data.code !== 0) {
    throw new Error('Gửi tin nhắn thất bại: ' + JSON.stringify(data));
  }
  return data;
}

// Cấu hình OpenAI
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

app.post('/webhook', async (req, res) => {
  try {
    const { encrypt } = req.body;
    if (!encrypt) {
      return res.status(400).json({ error: 'Missing encrypt field' });
    }

    // Giải mã event từ Lark
    const event = decryptLarkData(encrypt);

    console.log('=== Webhook event ===', event);

    if (!event || !event.message) {
      return res.status(200).send('No message event, ignore');
    }

    const { text, chat_id } = event.message;

    if (!text || !chat_id) {
      return res.status(200).send('No text or chat_id, ignore');
    }

    // Gọi OpenAI tạo phản hồi
    const completion = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: text }],
    });

    const replyText = completion.data.choices[0].message.content;

    // Lấy token app để gửi tin nhắn
    const token = await getAccessToken();

    // Gửi tin nhắn trả lời về Lark chat
    await sendReplyMessage(chat_id, replyText, token);

    return res.status(200).json({ msg: 'ok' });

  } catch (error) {
    console.error('❌ Lỗi xử lý webhook:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
