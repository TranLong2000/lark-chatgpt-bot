import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import axios from 'axios';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

// Middleware lưu rawBody để verify chữ ký
app.use((req, res, next) => {
  let data = [];
  req.on('data', chunk => data.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(data).toString();
    next();
  });
});

const PORT = process.env.PORT || 8080;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function verifyLarkSignature(req) {
  try {
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const signature = req.headers['x-lark-signature'];

    if (!timestamp || !nonce || !signature) {
      console.error('❌ Thiếu header xác thực từ Lark');
      return false;
    }

    const encryptKey = process.env.LARK_ENCRYPT_KEY;
    const encryptKeyBuffer = Buffer.from(encryptKey, 'base64');

    const str = `${timestamp}${nonce}${req.rawBody || ''}`;
    const hmac = crypto.createHmac('sha256', encryptKeyBuffer);
    hmac.update(str);
    const expectedSignature = hmac.digest('base64');

    if (signature !== expectedSignature) {
      console.error('❌ Chữ ký không hợp lệ');
      console.error('  -> expected:', expectedSignature);
      console.error('  -> received:', signature);
      return false;
    }
    console.log('✅ Xác thực chữ ký thành công');
    return true;
  } catch (err) {
    console.error('❌ Lỗi verify chữ ký:', err);
    return false;
  }
}

function decryptEncryptKey(encryptKey, iv, encrypted) {
  try {
    const key = Buffer.from(encryptKey, 'base64');
    if (key.length !== 32) {
      throw new Error(`LARK_ENCRYPT_KEY sau decode phải đủ 32 bytes, hiện tại là ${key.length}`);
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const encryptedBuffer = Buffer.from(encrypted, 'base64');
    let decrypted = decipher.update(encryptedBuffer, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('❌ Lỗi giải mã encrypt:', err);
    throw err;
  }
}

async function getTenantAccessToken() {
  try {
    const res = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    });
    return res.data.tenant_access_token;
  } catch (err) {
    console.error('❌ Lỗi lấy tenant_access_token:', err.response?.data || err.message);
    throw err;
  }
}

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
    console.log('✅ Đã gửi tin nhắn thành công tới user:', receiveId);
  } catch (err) {
    console.error('❌ Gửi tin nhắn Lark thất bại!');
    if (err.response) {
      console.error('👉 Response co
