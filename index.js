import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import axios from 'axios';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Hàm verify webhook signature (theo docs Lark)
function verifyLarkSignature(req) {
  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  const signature = req.headers['x-lark-signature'];

  if (!timestamp || !nonce || !signature) return false;

  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  const encryptKeyBuffer = Buffer.from(encryptKey, 'base64');

  const str = `${timestamp}${nonce}${req.rawBody || ''}`;
  const hmac = crypto.createHmac('sha256', encryptKeyBuffer);
  hmac.update(str);
  const expectedSignature = hmac.digest('base64');

  return signature === expectedSignature;
}

// Middleware để lấy rawBody phục vụ verify chữ ký
app.use((req, res, next) => {
  let data = [];
  req.on('data', chunk => {
    data.push(chunk);
  });
  req.on('end', () => {
    req.rawBody = Buffer.concat(data).toString();
    next();
  });
});

function decryptEncryptKey(encryptKey, iv, encrypted) {
  const key = Buffer.from(encryptKey, 'base64');
  if (key.length !== 32) {
    throw new Error(`LARK_ENCRYPT_KEY sau decode phải đủ 32 bytes, hiện tại là ${key.length}`);
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const encryptedBuffer = Buffer.from(encrypted, 'base64');
  let decrypted = decipher.update(encryptedBuffer, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function getTenantAccessToken() {
  const res = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  return res.data.tenant_access_token;
}

async function sendLarkMessage(receiveId, text) {
  const token = await getTenantAccessToken();

  try {
    await axios.post(
      `https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=user_id`,
      {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('✅ Đã gửi tin nhắn thành công tới user:', receiveId);
  } catch (err) {
    console.error('❌ Gửi tin nhắn Lark thất bại!');
    if (err.response) {
      console.error('👉 Response code:', err.response.status);
      console.error('👉 Response data:', err.response.data);
    } else {
      console.error('👉 Lỗi khác:', err.message);
    }
  }
}

app.post('/webhook', async (req, res) => {
  try {
    // Verify webhook signature
    if (!verifyLarkSignature(req)) {
      console.error('❌ Webhook verify signature failed');
      return res.sendStatus(401);
    }

    const body = req.body;

    if (body.challenge) {
      return res.json({ challenge: body.challenge });
    }

    if (!body.encrypt) {
      console.error('❌ Không có dữ liệu encrypt trong webhook');
      return res.sendStatus(400);
    }

    const iv = Buffer.alloc(16, 0); // 16 bytes zero IV

    const decryptedStr = decryptEncryptKey(process.env.LARK_ENCRYPT_KEY, iv, body.encrypt);
    const decrypted = JSON.parse(decryptedStr);

    const event = decrypted.event;

    if (event.message && event.message.message_type === 'text') {
      const userMessage = JSON.parse(event.message.content).text;
      const userId = event.sender.sender_id.user_id;

      console.log('📥 Nhận tin nhắn từ user:', userId, '-', userMessage);

      const reply = await openai.chat.completions.create({
        model: 'gpt-4', // Hoặc 'gpt-4o-mini' nếu bạn dùng OpenRouter
        messages: [
          { role: 'system', content: 'Bạn là trợ lý AI của Lark.' },
          { role: 'user', content: userMessage },
        ],
      });

      const aiReply = reply.choices[0].message.content;
      console.log('🤖 Trả lời từ GPT:', aiReply);

      await sendLarkMessage(userId, aiReply);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook xử lý lỗi:', error);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
