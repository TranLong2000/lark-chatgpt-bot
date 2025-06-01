import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import axios from 'axios';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

// Middleware lưu rawBody để verify signature
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
      console.error('[Verify] Missing headers');
      return false;
    }

    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
    const str = `${timestamp}${nonce}${req.rawBody || ''}`;

    const hmac = crypto.createHmac('sha256', key);
    hmac.update(str);
    const expected = hmac.digest('base64');

    if (expected !== signature) {
      console.error('[Verify] Signature mismatch');
      console.error('[Verify] Expected:', expected);
      console.error('[Verify] Received:', signature);
      return false;
    }

    console.log('[Verify] Signature OK');
    return true;
  } catch (err) {
    console.error('[Verify] Exception:', err.message);
    return false;
  }
}

function decryptEncryptKey(encryptKey, iv, encrypted) {
  try {
    const key = Buffer.from(encryptKey, 'base64');
    if (key.length !== 32) {
      throw new Error(`LARK_ENCRYPT_KEY must be 32 bytes after base64 decode, but got ${key.length}`);
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const encryptedBuffer = Buffer.from(encrypted, 'base64');
    let decrypted = decipher.update(encryptedBuffer, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[Decrypt] Error:', err.message);
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
    console.error('[Token] Error:', err.response?.data || err.message);
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
    console.log('[Send] Message sent to user:', receiveId);
  } catch (err) {
    console.error('[Send] Error sending message');
    if (err.response) {
      console.error('[Send] Response:', err.response.status, err.response.data);
    } else {
      console.error('[Send] Message:', err.message);
    }
  }
}

app.post('/webhook', async (req, res) => {
  console.log('--- Webhook Received ---');

  try {
    if (!verifyLarkSignature(req)) {
      return res.sendStatus(401);
    }

    const body = req.body;

    if (body.challenge) {
      console.log('[Challenge]', body.challenge);
      return res.json({ challenge: body.challenge });
    }

    if (!body.encrypt) {
      console.error('[Webhook] Missing encrypt field');
      return res.sendStatus(400);
    }

    const iv = Buffer.alloc(16, 0);
    const decryptedStr = decryptEncryptKey(process.env.LARK_ENCRYPT_KEY, iv, body.encrypt);
    const decrypted = JSON.parse(decryptedStr);

    console.log('[Webhook] Decrypted:', JSON.stringify(decrypted));

    // Trả về 200 NGAY để tránh lỗi 499
    res.sendStatus(200);

    const event = decrypted.event;

    if (event.message && event.message.message_type === 'text') {
      const userMessage = JSON.parse(event.message.content).text;
      const userId = event.sender.sender_id.user_id;

      console.log('[Message] From:', userId, '-', userMessage);

      // Xử lý nền
      (async () => {
        try {
          const reply = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
              { role: 'system', content: 'Bạn là trợ lý AI của Lark.' },
              { role: 'user', content: userMessage },
            ],
          });

          const aiReply = reply.choices[0].message.content;
          console.log('[GPT Reply]', aiReply);

          await sendLarkMessage(userId, aiReply);
        } catch (err) {
          console.error('[AI Handler] Error:', err.message);
          if (err.stack) console.error(err.stack);
        }
      })();
    } else {
      console.log('[Webhook] Event is not a text message');
    }
  } catch (err) {
    console.error('[Webhook] Fatal error:', err.message);
    if (err.stack) console.error(err.stack);
    // không gọi res.send vì đã gửi ở trên
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
