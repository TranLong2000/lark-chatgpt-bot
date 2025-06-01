import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import axios from 'axios';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const PORT = process.env.PORT || 8080;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

function verifyLarkSignature(req) {
  try {
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const signature = req.headers['x-lark-signature'];

    if (!timestamp || !nonce || !signature) {
      console.error('[Verify] Missing headers');
      return false;
    }

    const payload = req.rawBody || '';
    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
    const str = `${timestamp}${nonce}${payload}`;

    const hmac = crypto.createHmac('sha256', key);
    hmac.update(str);
    const expected = hmac.digest('base64');

    if (expected !== signature) {
      console.error('[Verify] Signature mismatch');
      return false;
    }

    console.log('[Verify] Signature OK');
    return true;
  } catch (err) {
    console.error('[Verify] Error:', err.message);
    return false;
  }
}

function decryptEncryptKey(encryptKey, iv, encrypted) {
  try {
    const key = Buffer.from(encryptKey, 'base64');
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
    const response = await axios.post(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }
    );
    return response.data.tenant_access_token;
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
    console.error('[Send] Failed:', err.response?.data || err.message);
  }
}

app.post('/webhook', async (req, res) => {
  logRequest(req);
  res.sendStatus(200); // Always return 200 to avoid 499

  try {
    if (!verifyLarkSignature(req)) {
      console.error('[Webhook] Invalid signature');
      return;
    }

    const body = req.body;

    if (body.challenge) {
      console.log('[Webhook] Challenge:', body.challenge);
      return;
    }

    if (!body.encrypt) {
      console.error('[Webhook] No "encrypt" field');
      return;
    }

    const iv = Buffer.alloc(16, 0);
    const decryptedStr = decryptEncryptKey(process.env.LARK_ENCRYPT_KEY, iv, body.encrypt);
    const decryptedData = JSON.parse(decryptedStr);

    console.log('[Webhook] Decrypted:', decryptedData);

    const event = decryptedData.event;
    if (!event || !event.message || event.message.message_type !== 'text') {
      console.log('[Webhook] Not a text message');
      return;
    }

    const messageObj = JSON.parse(event.message.content);
    const userMessage = messageObj.text;
    const userId = event.sender.sender_id.user_id;
    console.log('[Webhook] Message from', userId, ':', userMessage);

    const reply = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Bạn là trợ lý AI của Lark.' },
        { role: 'user', content: userMessage },
      ],
    });

    const aiReply = reply.choices[0].message.content;
    console.log('[AI] GPT reply:', aiReply);

    await sendLarkMessage(userId, aiReply);
  } catch (err) {
    console.error('[Webhook] Error:', err.stack || err);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
