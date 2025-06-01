import express from 'express';
import crypto from 'crypto';
import { Buffer } from 'buffer';
import bodyParser from 'body-parser';
import { Configuration, OpenAIApi } from 'openai';

const app = express();
const port = process.env.PORT || 8080;

// ✅ Middleware giữ lại raw body để verify chữ ký
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// ✅ OpenAI cấu hình
const openai = new OpenAIApi(new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
}));

// ✅ Hàm giải mã payload từ Lark
function decryptLarkPayload(encrypt) {
  try {
    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
    const iv = key.slice(0, 16); // AES key cũng dùng làm IV
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypt, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('❌ Decryption failed:', error.message);
    return null;
  }
}

// ✅ Hàm xác minh chữ ký từ Lark
function verifyLarkSignature(req) {
  try {
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const signature = req.headers['x-lark-signature'];

    const rawBody = req.rawBody || '';
    const str = `${timestamp}${nonce}${rawBody}`;

    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(str);
    const expected = hmac.digest('base64');

    const match = expected === signature;
    if (!match) {
      console.error('[Verify] Signature mismatch');
    }
    return match;
  } catch (err) {
    console.error('[Verify] Error verifying signature:', err.message);
    return false;
  }
}

// ✅ Route webhook
app.post('/webhook', async (req, res) => {
  console.log('--- New Webhook Request ---');
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);

  if (!verifyLarkSignature(req)) {
    return res.status(401).send('Invalid signature');
  }

  const { encrypt } = req.body;
  const payload = decryptLarkPayload(encrypt);
  if (!payload) return res.status(400).send('Cannot decrypt');

  console.log('[Webhook] Decrypted Payload:', payload);

  // Handle challenge
  if (payload.type === 'url_verification') {
    return res.send({ challenge: payload.challenge });
  }

  // Handle message
  if (payload.header.event_type === 'im.message.receive_v1') {
    const message = payload.event.message.content;
    const text = JSON.parse(message).text;

    try {
      const completion = await openai.createChatCompletion({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: text }],
      });

      const reply = completion.data.choices[0].message.content;
      console.log('[GPT] Reply:', reply);
      // TODO: gửi reply lại qua API Lark nếu cần
    } catch (err) {
      console.error('[GPT] Error:', err.message);
    }
  }

  res.status(200).send('ok');
});

app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});
