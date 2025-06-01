import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import axios from 'axios';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();

// Luôn parse JSON, nhưng chúng ta cũng cần lấy rawBody để verify signature
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const PORT = process.env.PORT || 8080;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// In toàn bộ headers và body của webhook để debug
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

// Xác thực chữ ký Lark
function verifyLarkSignature(req) {
  try {
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const signature = req.headers['x-lark-signature'];

    if (!timestamp || !nonce || !signature) {
      console.error('[Verify] Missing x-lark-request-timestamp / x-lark-request-nonce / x-lark-signature');
      return false;
    }

    // Lấy rawBody từ middleware phía trên
    const payload = req.rawBody || '';

    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
    const str = `${timestamp}${nonce}${payload}`;

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
    console.error('[Verify] Exception during verify:', err.message);
    return false;
  }
}

// Giải mã trường `encrypt`
function decryptEncryptKey(encryptKey, iv, encrypted) {
  try {
    const key = Buffer.from(encryptKey, 'base64');
    if (key.length !== 32) {
      throw new Error(`LARK_ENCRYPT_KEY must be 32 bytes after base64 decode, got ${key.length}`);
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const encryptedBuffer = Buffer.from(encrypted, 'base64');
    let decrypted = decipher.update(encryptedBuffer, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[Decrypt] Error during decryption:', err.message);
    throw err;
  }
}

// Lấy tenant_access_token từ Lark
async function getTenantAccessToken() {
  try {
    const response = await axios.post(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }
    );
    return response.data.tenant_access_token;
  } catch (err) {
    console.error('[Token] Error fetching tenant_access_token:', err.response?.data || err.message);
    throw err;
  }
}

// Gửi tin nhắn text lên Lark
async function sendLarkMessage(receiveId, text) {
  try {
    const token = await getTenantAccessToken();
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
    console.error('[Send] Failed to send message');
    if (err.response) {
      console.error('  Response code:', err.response.status);
      console.error('  Response data:', err.response.data);
    } else {
      console.error('  Error message:', err.message);
    }
  }
}

// Endpoint webhook
app.post('/webhook', async (req, res) => {
  // In request để debug
  logRequest(req);

  // Mặc định luôn trả 200 càng sớm càng tốt, để tránh Lark timeout (499)
  // Chúng ta sẽ làm background job phía sau
  res.sendStatus(200);

  // Bắt đầu xử lý logic sau khi đã trả 200
  try {
    // 1. Verify signature
    const isValid = verifyLarkSignature(req);
    if (!isValid) {
      console.error('[Webhook] Invalid signature – stopping processing.');
      return;
    }

    const body = req.body;

    // 2. Nếu webhook challenge (lầ
