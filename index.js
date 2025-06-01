import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

// Middleware để parse raw body (vì Lark gửi encrypted payload)
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Chuyển base64-url sang chuẩn base64
function base64UrlToBase64(base64Url) {
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return base64;
}

// Hàm decrypt payload từ Lark
function decryptEncryptKey(encryptStr, encryptKey) {
  const base64Key = base64UrlToBase64(encryptKey);
  const key = Buffer.from(base64Key, 'base64');

  if (key.length !== 32) {
    throw new Error(`Invalid key length: ${key.length}, expected 32 bytes`);
  }

  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);

  let decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptStr, 'base64')),
    decipher.final(),
  ]);

  // Xóa padding PKCS#7
  const pad = decrypted[decrypted.length - 1];
  decrypted = decrypted.slice(0, decrypted.length - pad);

  // Bỏ 16 bytes đầu + 4 bytes chiều dài JSON
  const jsonLength = decrypted.readUInt32BE(16);
  const jsonPayload = decrypted.slice(20, 20 + jsonLength).toString();

  return JSON.parse(jsonPayload);
}

// Khởi tạo OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post('/webhook', async (req, res) => {
  try {
    // Kiểm tra header xác thực
    const verificationToken = process.env.LARK_VERIFICATION_TOKEN;
    const headerToken = req.headers['x-lark-verify-token'];
    if (headerToken !== verificationToken) {
      return res.status(401).send('Unauthorized: Invalid verification token');
    }

    const encryptKey = process.env.LARK_ENCRYPT_KEY;
    const body = req.body;

    // Nếu body có trường encrypt thì giải mã
    let event = body;
    if (body.encrypt) {
      event = decryptEncryptKey(body.encrypt, encryptKey);
    }

    // Xử lý các loại event
    if (event.header?.event_type === 'im.message.receive_v1') {
      const msg = event.event.message;
      const userId = event.event.sender.sender_id.open_id;

      console.log(`Tin nhắn nhận được từ ${userId}:`, msg.text);

      // Gửi prompt cho OpenAI
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: msg.text }],
      });

      const replyText = completion.choices[0].message.content;

      // Trả về theo định dạng Lark yêu cầu
      return res.json({
        challenge: body.challenge,
        msg_type: 'text',
        content: {
          text: replyText,
        },
      });
    }

    // Trả về thành công nếu không phải event tin nhắn
    res.json({ challenge: body.challenge || '' });
  } catch (err) {
    console.error('Webhook xử lý lỗi:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});
