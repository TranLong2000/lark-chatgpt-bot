import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Lấy access token động từ Lark
let cachedToken = null;
let tokenExpire = 0;

async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpire) {
    return cachedToken;
  }

  const res = await axios.post('https://open.larkoffice.com/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET
  });

  cachedToken = res.data.tenant_access_token;
  tokenExpire = now + res.data.expire * 1000 - 60_000; // Trừ 1 phút dự phòng
  return cachedToken;
}

// Hàm xác minh chữ ký Lark
function verifySignature(req) {
  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  const signature = req.headers['x-lark-signature'];
  const body = JSON.stringify(req.body);
  const encryptKey = process.env.LARK_ENCRYPT_KEY;

  const raw = timestamp + nonce + encryptKey + body;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return hash === signature;
}

// Endpoint webhook
app.post('/webhook', async (req, res) => {
  const event = req.body;

  // Trả lời challenge khi verify
  if (event.type === 'url_verification') {
    return res.send({ challenge: event.challenge });
  }

  if (!verifySignature(req)) {
    return res.status(401).send('Invalid signature');
  }

  // Xử lý tin nhắn
  if (event.header.event_type === 'im.message.receive_v1') {
    const message = event.event.message;
    const senderId = event.event.sender.sender_id.user_id;

    // Giải mã nội dung tin nhắn (giả sử text/plain)
    const content = JSON.parse(message.content);
    const text = content.text;

    // Gọi OpenAI ChatGPT API
    let reply = 'Xin lỗi, tôi không thể trả lời ngay bây giờ.';
    try {
      const openaiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: text }]
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      reply = openaiRes.data.choices[0].message.content;
    } catch (err) {
      console.error('Lỗi gọi OpenAI:', err?.response?.data || err.message);
    }

    // Gửi lại tin nhắn cho người dùng
    try {
      const token = await getTenantAccessToken();

      await axios.post('https://open.larkoffice.com/open-apis/im/v1/messages', {
        receive_id: senderId,
        content: JSON.stringify({ text: reply }),
        msg_type: 'text'
      }, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        params: {
          receive_id_type: 'user_id'
        }
      });
    } catch (err) {
      console.error('Lỗi gửi tin nhắn về Lark:', err?.response?.data || err.message);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
