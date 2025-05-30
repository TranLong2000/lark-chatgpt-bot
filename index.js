import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN;
const LARK_DOMAIN = 'https://open.larksuite.com';

let cachedToken = null;
let tokenExpire = 0;

async function getAccessToken() {
  // nếu token chưa hết hạn thì trả luôn
  if (cachedToken && Date.now() < tokenExpire) {
    return cachedToken;
  }

  const res = await fetch(`${LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: LARK_APP_ID,
      app_secret: LARK_APP_SECRET,
    }),
  });

  const data = await res.json();

  if (data.code === 0) {
    cachedToken = data.app_access_token;
    // app_access_token thường hết hạn 2 tiếng, để an toàn set 1h50m
    tokenExpire = Date.now() + 1000 * 60 * 110;
    return cachedToken;
  } else {
    console.error('Lấy access token lỗi:', data);
    return null;
  }
}

async function sendMessage(openId, text) {
  const token = await getAccessToken();
  if (!token) {
    console.error('Không lấy được access token, không gửi được message');
    return;
  }

  const res = await fetch(`${LARK_DOMAIN}/open-apis/im/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      receive_id_type: 'open_id',
      receive_id: openId,
      content: JSON.stringify({ text }),
      msg_type: 'text',
    }),
  });

  const data = await res.json();
  if (data.code !== 0) {
    console.error('Gửi message lỗi:', data);
  }
}

app.post('/webhook', async (req, res) => {
  // Xác thực verify token header (token Lark gửi lên webhook)
  const verifyToken = req.headers['x-lark-verify-token'];
  if (verifyToken !== LARK_VERIFICATION_TOKEN) {
    console.log('[❌] Invalid verify token:', verifyToken);
    return res.status(401).send('Invalid verify token');
  }

  const body = req.body;

  // Trả về challenge khi Lark verify webhook URL lần đầu
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  if (body.type === 'event_callback') {
    const event = body.event;

    // Chỉ xử lý sự kiện tin nhắn người dùng gửi
    if (event && event.message && event.sender) {
      try {
        const userText = JSON.parse(event.message.content).text;
        const userOpenId = event.sender.open_id;

        // Gọi OpenAI để tạo câu trả lời
        const completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Bạn là trợ lý ảo LarkGPT.' },
            { role: 'user', content: userText },
          ],
        });

        const replyText = completion.choices[0].message.content;

        console.log(`User: ${userText}`);
        console.log(`Reply: ${replyText}`);

        // Gửi câu trả lời lại user
        await sendMessage(userOpenId, replyText);

      } catch (err) {
        console.error('Lỗi xử lý message:', err);
      }
    }

    // Luôn trả về 200 OK cho Lark webhook
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server đang chạy trên port ${port}`);
});
