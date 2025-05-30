require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // hoặc import fetch từ 'node-fetch' nếu dùng ES Module
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN;
const LARK_DOMAIN = 'https://open.larksuite.com';

let accessToken = null;

// Hàm lấy Access Token (app access token)
async function getAccessToken() {
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
    return data.app_access_token;
  } else {
    console.error('Lấy access token lỗi:', data);
    return null;
  }
}

// Gửi trả lời message đến user
async function replyMessage(openId, text) {
  if (!accessToken) {
    accessToken = await getAccessToken();
  }
  if (!accessToken) {
    console.error('Không lấy được access token');
    return;
  }

  const res = await fetch(`${LARK_DOMAIN}/open-apis/im/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);

  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Xác thực verify token nếu bạn muốn
  const token = req.headers['x-lark-verify-token'];
  if (!token || token !== LARK_VERIFICATION_TOKEN) {
    console.log('[❌] Invalid verify token:', token);
    return res.status(401).send('Invalid verify token');
  }

  const event = req.body.event;
  if (event && event.message && event.message.content && event.sender) {
    const userMessage = JSON.parse(event.message.content).text || '';
    const openId = event.sender.open_id;

    try {
      // Gọi OpenAI để tạo câu trả lời
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Bạn là trợ lý ảo LarkGPT.' },
          { role: 'user', content: userMessage },
        ],
      });

      const reply = completion.choices[0].message.content;

      console.log(`[🤖] User: ${userMessage}`);
      console.log(`[🤖] Bot trả lời: ${reply}`);

      // Gửi trả lời tới user
      await replyMessage(openId, reply);

    } catch (error) {
      console.error('[❌] OpenAI error:', error);
    }
  }

  res.sendStatus(200);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Bot đang chạy trên cổng ${port}`);
});
