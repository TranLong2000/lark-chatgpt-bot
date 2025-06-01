const express = require('express');
const crypto = require('crypto');
const { Buffer } = require('buffer');
const bodyParser = require('body-parser');
const axios = require('axios');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

// Middleware giữ rawBody để verify chữ ký
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Khởi tạo OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// In toàn bộ request để debug
function logRequest(req) {
  console.log('--- New Webhook Request ---');
  console.log('URL:', req.originalUrl);
  console.log('Method:', req.method);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  try {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  } catch {
    console.log('Body: <cannot stringify>');
  }
}

// Xác thực chữ ký từ Lark
function verifyLarkSignature(req) {
  try {
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const signature = req.headers['x-lark-signature'];

    if (!timestamp || !nonce || !signature) {
      console.error('[Verify] Missing headers for signature');
      return false;
    }

    const rawBody = req.rawBody || '';
    const str = `${timestamp}${nonce}${rawBody}`;

    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(str);
    const expected = hmac.digest(); // Buffer

    // Xử lý chữ ký nhận được
    let signatureBuffer;
    // Kiểm tra nếu là hex string 64 ký tự thì convert từ hex
    if (/^[0-9a-f]{64}$/i.test(signature)) {
      signatureBuffer = Buffer.from(signature, 'hex');
    } else {
      // Nếu không, giả định Base64
      signatureBuffer = Buffer.from(signature, 'base64');
    }

    if (expected.length !== signatureBuffer.length || !crypto.timingSafeEqual(expected, signatureBuffer)) {
      console.error('[Verify] Signature mismatch');
      console.error('Expected (base64):', expected.toString('base64'));
      console.error('Received:', signature);
      return false;
    }

    console.log('[Verify] Signature OK');
    return true;
  } catch (err) {
    console.error('[Verify] Error verifying signature:', err.message);
    return false;
  }
}

// Giải mã payload từ Lark
function decryptLarkPayload(encrypt) {
  try {
    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
    const iv = key.slice(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypt, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('[Decrypt] Failed to decrypt payload:', error.message);
    return null;
  }
}

// Gửi message cho user qua Lark
async function sendLarkMessage(receiveId, text) {
  try {
    const tokenRes = await axios.post(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }
    );
    const token = tokenRes.data.tenant_access_token;

    await axios.post(
      'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=user_id',
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

    console.log('[Send] Message sent to user:', receiveId);
  } catch (err) {
    console.error('[Send] Failed to send message:', err.response?.data || err.message);
  }
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  logRequest(req);
  res.sendStatus(200); // Trả 200 OK sớm để tránh timeout

  if (!verifyLarkSignature(req)) {
    console.error('[Webhook] Invalid signature – stop.');
    return;
  }

  const { encrypt } = req.body;
  if (!encrypt) {
    console.error('[Webhook] Missing "encrypt" field.');
    return;
  }

  const payload = decryptLarkPayload(encrypt);
  if (!payload) {
    console.error('[Webhook] Cannot decrypt payload.');
    return;
  }

  console.log('[Webhook] Decrypted Payload:', JSON.stringify(payload, null, 2));

  if (payload.type === 'url_verification') {
    console.log('[Webhook] URL Verification:', payload.challenge);
    return;
  }

  const header = payload.header || {};
  if (header.event_type === 'im.message.receive_v1') {
    const messageContent = payload.event.message.content;
    let userMessage;

    try {
      userMessage = JSON.parse(messageContent).text;
    } catch {
      console.error('[Webhook] Cannot parse message content.');
      return;
    }

    const userId = payload.event.sender.sender_id.user_id;
    console.log('[Webhook] Received from', userId, ':', userMessage);

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'Bạn là trợ lý AI của Lark.' },
          { role: 'user', content: userMessage },
        ],
      });

      const aiReply = completion.choices[0].message.content;
      console.log('[AI] GPT Reply:', aiReply);

      await sendLarkMessage(userId, aiReply);
    } catch (err) {
      console.error('[AI] Error:', err.response?.data || err.message);
    }
  } else {
    console.log('[Webhook] Ignored event type:', header.event_type);
  }
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
