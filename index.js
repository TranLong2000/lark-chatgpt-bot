import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN;
const LARK_ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

function decryptEncryptKey(encryptKey, encryptData) {
  const key = Buffer.from(encryptKey, 'base64');
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptData, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function encryptEncryptKey(encryptKey, decryptData) {
  const key = Buffer.from(encryptKey, 'base64');
  const iv = key.slice(0, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(decryptData, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

app.post('/webhook', async (req, res) => {
  try {
    const encryptData = req.body.encrypt;
    if (!encryptData) {
      return res.status(400).send('No encrypt field');
    }

    const decrypted = decryptEncryptKey(LARK_ENCRYPT_KEY, encryptData);
    const event = JSON.parse(decrypted);

    if (event.header.token !== LARK_VERIFICATION_TOKEN) {
      return res.status(403).send('Verification token mismatch');
    }

    if (event.header.event_type === 'im.message.receive_v1') {
      const message = event.event.message;
      if (message.message_type !== 'text') {
        return res.send('Only text messages supported');
      }

      const userText = JSON.parse(message.content).text;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: userText }],
        max_tokens: 300,
      });

      const botReply = response.choices[0].message.content;

      const reply = {
        msg_type: 'text',
        content: botReply,
      };

      const replyEncrypt = encryptEncryptKey(LARK_ENCRYPT_KEY, JSON.stringify(reply));

      res.json({ encrypt: replyEncrypt });
    } else {
      res.json({ msg: 'Not a message event' });
    }
  } catch (err) {
    console.error('Webhook xử lý lỗi:', err);
    res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
