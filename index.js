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
      console.error('ERROR: Missing authentication headers from Lark');
      return false;
    }

    const encryptKey = process.env.LARK_ENCRYPT_KEY;
    const encryptKeyBuffer = Buffer.from(encryptKey, 'base64');

    const str = `${timestamp}${nonce}${req.rawBody || ''}`;
    const hmac = crypto.createHmac('sha256', encryptKeyBuffer);
    hmac.update(str);
    const expectedSignature = hmac.digest('base64');

    if (signature !== expectedSignature) {
      console.error('ERROR: Signature verification failed');
      console.error('  -> expected:', expectedSignature);
      console.error('  -> received:', signature);
      return false;
    }
    console.log('SUCCESS: Signature verified');
    return true;
  } catch (err) {
    console.error('ERROR: Signature verification error:', err);
    return false;
  }
}

function decryptEncryptKey(encryptKey, iv, encrypted) {
  try {
    const key = Buffer.from(encryptKey, 'base64');
    if (key.length !== 32) {
      throw new Error(`LARK_ENCRYPT_KEY after base64 decode must be 32 bytes, current length: ${key.length}`);
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const encryptedBuffer = Buffer.from(encrypted, 'base64');
    let decrypted = decipher.update(encryptedBuffer, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('ERROR: Decrypt encrypt failed:', err);
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
    console.error('ERROR: Failed to get tenant_access_token:', err.response?.data || err.message);
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
    console.log('SUCCESS: Message sent to user:', receiveId);
  } catch (err) {
    console.error('ERROR: Failed to send Lark message!');
    if (err.response) {
      console.error('--> Response code:', err.response.status);
      console.error('--> Response data:', err.response.data);
    } else {
      console.error('--> Other error:', err.message);
    }
  }
}

app.post('/webhook', async (req, res) => {
  console.log('Received webhook at:', new Date().toISOString());

  try {
    if (!verifyLarkSignature(req)) {
      return res.sendStatus(401);
    }

    const body = req.body;

    if (body.challenge) {
      console.log('Webhook challenge received:', body.challenge);
      return res.json({ challenge: body.challenge });
    }

    if (!body.encrypt) {
      console.error('ERROR: Webhook payload missing encrypt field');
      return res.sendStatus(400);
    }

    const iv = Buffer.alloc(16, 0);
    const decryptedStr = decryptEncryptKey(process.env.LARK_ENCRYPT_KEY, iv, body.encrypt);
    const decrypted = JSON.parse(decryptedStr);
    console.log('Decrypted payload:', JSON.stringify(decrypted));

    const event = decrypted.event;

    if (event.message && event.message.message_type === 'text') {
      const userMessage = JSON.parse(event.message.content).text;
      const userId = event.sender.sender_id.user_id;

      console.log('Received message from user:', userId, '-', userMessage);

      // Trả về 200 ngay để tránh lỗi 499 timeout
      res.sendStatus(200);

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
          console.log('GPT reply:', aiReply);

          await sendLarkMessage(userId, aiReply);
        } catch (err) {
          console.error('ERROR: OpenAI call or send message error:', err);
        }
      })();

      return;
    }

    console.log('Non-text message event received, ignored');
    res.sendStatus(200);
  } catch (error) {
    console.error('ERROR: Webhook handling error:', error);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
