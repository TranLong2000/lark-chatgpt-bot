const express = require('express');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { createOpenAI } = require('@ai-sdk/openai');
const { streamText } = require('ai');
const { MessageCrypto } = require('@larksuiteoapi/core');
const fetch = require('node-fetch');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Giữ rawBody để verify chữ ký
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const larkCrypto = new MessageCrypto({
  encryptKey: process.env.LARK_ENCRYPT_KEY,
  verificationToken: process.env.LARK_VERIFICATION_TOKEN,
});

app.post('/webhook', async (req, res) => {
  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  const signature = req.headers['x-lark-signature'];
  const rawBody = req.rawBody;

  console.log('\n--- New Webhook Request ---');
  console.log('Headers:', req.headers);
  console.log('Body:', rawBody);

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

  const { encrypt } = JSON.parse(rawBody);
  const decrypted = larkCrypto.decryptMessage(encrypt);
  console.log('[Decrypted Body]:', decrypted);

  if (decrypted.type === 'url_verification') {
    return res.send({ challenge: decrypted.challenge });
  }

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

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
