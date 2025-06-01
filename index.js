import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { buffer } from 'stream/consumers';
import { MessageCrypto } from '@larksuiteoapi/core';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Lưu raw body để verify signature
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Lark crypto (dùng để decrypt body)
const larkCrypto = new MessageCrypto({
  encryptKey: process.env.LARK_ENCRYPT_KEY,
  verificationToken: process.env.LARK_VERIFICATION_TOKEN,
});

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  const signature = req.headers['x-lark-signature'];
  const rawBody = req.rawBody;

  console.log('\n--- New Webhook Request ---');
  console.log('Headers:', req.headers);
  console.log('Body:', rawBody);

  // Xác thực chữ ký HMAC-SHA256
  const stringToSign = timestamp + nonce + rawBody;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.LARK_ENCRYPT_KEY)
    .update(stringToSign)
    .digest('hex');

  console.log('[Verify] Expected (hex):', expectedSignature);
  console.log('[Verify] Received:', signature);

  if (expectedSignature !== signature) {
    console.log('[Webhook] Invalid signature – stop.');
    return res.status(401).send('Invalid signature');
  }

  // Giải mã nội dung
  const { encrypt } = JSON.parse(rawBody);
  const decrypted = larkCrypto.decryptMessage(encrypt);
  console.log('[Decrypted Body]:', decrypted);

  // Đáp ứng event challenge (nếu có)
  if (decrypted.type === 'url_verification') {
    return res.send({ challenge: decrypted.challenge });
  }

  // Xử lý message
  if (decrypted.schema === '2.0' && decrypted.header.event_type === 'im.message.receive_v1') {
    const message = decrypted.event.message;
    const userMessage = message.content ? JSON.parse(message.content).text : '';

    if (userMessage) {
      console.log(`[User Message]: ${userMessage}`);
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const { textStream } = await streamText({
        model: openai.chat('gpt-4o'),
        messages: [{ role: 'user', content: userMessage }],
      });

      const chunks = [];
      for await (const chunk of textStream) {
        chunks.push(chunk.text);
      }

      const finalResponse = chunks.join('');
      console.log(`[Assistant Reply]: ${finalResponse}`);

      await fetch('https://open.larksuite.com/open-apis/im/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await getTenantAccessToken()}`,
        },
        body: JSON.stringify({
          receive_id: message.sender.sender_id.user_id,
          content: JSON.stringify({ text: finalResponse }),
          msg_type: 'text',
          receive_id_type: 'user_id',
        }),
      });
    }
  }

  return res.sendStatus(200);
});

// Hàm lấy tenant access token
async function getTenantAccessToken() {
  const resp = await fetch(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }),
  });

  const data = await resp.json();
  return data.tenant_access_token;
}

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
