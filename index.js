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

function decryptEncryptKey(encryptKey, iv) {
  const key = Buffer.from(encryptKey, 'base64');

  if (key.length !== 32) {
    throw new Error(`LARK_ENCRYPT_KEY sau decode phải đủ 32 bytes, hiện tại là ${key.length}`);
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return (encrypted) => {
    const encryptedBuffer = Buffer.from(encrypted, 'base64');
    let decrypted = decipher.update(encryptedBuffer, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  };
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
    const res = await axios.post(
      `https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=user_id`,
      {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
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
  const { challenge, encrypt, header } = req.body;

  if (challenge) {
    return res.json({ challenge });
  }

  try {
    const iv = Buffer.from('0000000000000000');
    const decrypt = decryptEncryptKey(process.env.LARK_ENCRYPT_KEY, iv);
    const decrypted = JSON.parse(decrypt(encrypt));

    const event = decrypted.event;

    if (event.message && event.message.message_type === 'text') {
      const userMessage = JSON.parse(event.message.content).text;
      const userId = event.sender.sender_id.user_id;

      console.log('📥 Nhận tin nhắn từ user:', userId, '-', userMessage);

      const reply = await openai.chat.completions.create({
        model: 'gpt-4',
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
