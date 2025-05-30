require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN;
const LARK_DOMAIN = process.env.LARK_DOMAIN || 'https://open.larksuite.com';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Lưu token access Lark, refresh sau 1h (3600s)
let larkAccessToken = null;
let larkTokenExpire = 0;

// Hàm lấy access token
async function getLarkAccessToken() {
  const now = Date.now();
  if (larkAccessToken && now < larkTokenExpire) {
    return larkAccessToken;
  }

  try {
    const res = await axios.post(`${LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`, {
      app_id: LARK_APP_ID,
      app_secret: LARK_APP_SECRET,
    });
    if (res.data && res.data.code === 0) {
      larkAccessToken = res.data.app_access_token;
      larkTokenExpire = now + (res.data.expire * 1000) - 60000; // trừ 60s để refresh sớm hơn
      return larkAccessToken;
    } else {
      throw new Error(`Lark auth error: ${JSON.stringify(res.data)}`);
    }
  } catch (e) {
    console.error('Failed to get Lark access token:', e);
    throw e;
  }
}

// Hàm trả lời message
async function replyMessage(messageId, text) {
  const token = await getLarkAccessToken();

  try {
    const res = await axios.post(`${LARK_DOMAIN}/open-apis/im/v1/messages/reply`, {
      message_id: messageId,
      content: JSON.stringify({ text }),
      msg_type: 'text',
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
    });
    if (res.data.code !== 0) {
      console.error('Error replying message:', res.data);
    }
  } catch (e) {
    console.error('Failed to reply message:', e);
  }
}

// Xác thực webhook token
function verifyToken(req) {
  const token = req.headers['x-lark-verify-token'] || '';
  return token === LARK_VERIFICATION_TOKEN;
}

app.post('/webhook', async (req, res) => {
  try {
    if (!verifyToken(req)) {
      return res.status(401).send('Invalid token');
    }

    const event = req.body.event;
    if (!event) {
      return res.status(400).send('No event data');
    }

    if (event.type === 'im.message.receive_v1') {
      const { message } = event;
      const { text, message_id } = message;

      // Gọi OpenAI tạo câu trả lời
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: text },
        ],
      });

      const replyText = completion.choices[0].message.content;

      // Trả lời tin nhắn Lark
      await replyMessage(message_id, replyText);
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('Error handling webhook:', err);
    res.status(500).send('Internal server error');
  }
});

app.listen(PORT, () => {
  console.log(`Lark OpenAI bot running on port ${PORT}`);
});
