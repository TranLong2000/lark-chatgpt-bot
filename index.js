// index.js
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

// In toàn bộ headers + body của request để debug
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

    // Đọc key gốc (base64) mà Lark cung cấp
    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(str);
    const expected = hmac.digest('base64');

    if (expected !== signature) {
      console.error('[Verify] Signature mismatch');
      console.error('  Expected:', expected);
      console.error('  Received:', signature);
      return false;
    }

    console.log('[Verify] Signature OK');
    return true;
  } catch (err) {
    console.error('[Verify] Error verifying signature:', err.message);
    return false;
  }
}

// Giải mã payload "encrypt" từ Lark
function decryptLarkPayload(encrypt) {
  try {
    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
    // Lấy 16 byte đầu làm IV
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

// Gọi API Lark để gửi message (text) về user
async function sendLarkMessage(receiveId, text) {
  try {
    // Lấy tenant_access_token
    const tokenRes = await axios.post(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }
    );
    const token = tokenRes.data.tenant_access_token;

    // Gửi tin nhắn
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

    console.log('[Send] Message sent to user:', receiveId);
  } catch (err) {
    console.error('[Send] Failed to send message:', err.response?.data || err.message);
  }
}

// Route webhook nhận từ Lark
app.post('/webhook', async (req, res) => {
  // 1) Log request lên để debug
  logRequest(req);

  // 2) Trả về 200 ngay lập tức để Lark không timeout (499)
  res.sendStatus(200);

  // 3) Xác thực chữ ký
  if (!verifyLarkSignature(req)) {
    console.error('[Webhook] Invalid signature – stop processing.');
    return;
  }

  const { encrypt } = req.body;
  if (!encrypt) {
    console.error('[Webhook] Missing "encrypt" field – stop.');
    return;
  }

  // 4) Giải mã payload
  const payload = decryptLarkPayload(encrypt);
  if (!payload) {
    console.error('[Webhook] Decrypt returned null – stop.');
    return;
  }
  console.log('[Webhook] Decrypted Payload:', JSON.stringify(payload, null, 2));

  // 5) Nếu là url_verification (challenge), trả challenge
  if (payload.type === 'url_verification') {
    // Lưu ý: do chúng ta đã res.sendStatus(200) ở trên, nên Lark sẽ không nhận JSON challenge.
    // Trong lần cài đặt đầu tiên, bạn có thể sửa thành `return res.json({ challenge: payload.challenge });`
    console.log('[Webhook] Handling url_verification, challenge:', payload.challenge);
    return;
  }

  // 6) Nếu event_type là im.message.receive_v1
  const header = payload.header || {};
  if (header.event_type === 'im.message.receive_v1') {
    const messageContent = payload.event.message.content;
    let userMessage;
    try {
      userMessage = JSON.parse(messageContent).text;
    } catch {
      console.error('[Webhook] Cannot
