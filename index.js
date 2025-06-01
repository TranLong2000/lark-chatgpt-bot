import express from 'express';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN;
const ENCRYPT_KEY_BASE64 = process.env.LARK_ENCRYPT_KEY;

if (!ENCRYPT_KEY_BASE64) {
  throw new Error("Thiếu biến môi trường LARK_ENCRYPT_KEY");
}

const ENCRYPT_KEY = Buffer.from(ENCRYPT_KEY_BASE64, 'base64');
if (ENCRYPT_KEY.length !== 32) {
  throw new Error(`LARK_ENCRYPT_KEY sau decode phải đủ 32 bytes, hiện tại là ${ENCRYPT_KEY.length}`);
}

const decrypt = (encrypt) => {
  const encryptedData = Buffer.from(encrypt, 'base64');
  const iv = encryptedData.subarray(0, 16);
  const ciphertext = encryptedData.subarray(16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPT_KEY, iv);
  let decrypted = decipher.update(ciphertext, null, 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post('/webhook', async (req, res) => {
  const { encrypt, challenge, token, type, schema } = req.body;

  // 1. Verification challenge
  if (type === 'url_verification') {
    return res.json({ challenge });
  }

  // 2. Token verification
  if (token !== VERIFICATION_TOKEN) {
    return res.status(401).send('Invalid token');
  }

  try {
    const eventBody = decrypt(encrypt);
    const eventType = eventBody.header?.event_type;

    if (eventType === 'im.message.receive_v1') {
      const messageText = eventBody.event?.message?.content;
      const parsedContent = JSON.parse(messageText);
      const userMessage = parsedContent.text?.trim();

      if (userMessage) {
        const reply = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Bạn là trợ lý AI hữu ích.' },
            { role: 'user', content: userMessage }
          ]
        });

        const replyText = reply.choices[0].message.content;
        const replyPayload = {
          receive_id: eventBody.event.sender.sender_id.user_id,
          msg_type: 'text',
          content: JSON.stringify({ text: replyText })
        };

        // Gửi lại reply về cho Lark
        await fetch('https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=user_id', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${await getTenantToken()}`
          },
          body: JSON.stringify(replyPayload)
        });
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook xử lý lỗi:', error);
    res.status(500).send('Internal Error');
  }
});

async function getTenantToken() {
  const res = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET
    })
  });

  const data = await res.json();
  return data.tenant_access_token;
}

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
