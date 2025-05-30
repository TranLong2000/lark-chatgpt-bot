require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Khởi tạo OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Hàm xác thực token từ header
function verifyToken(req) {
  const token = req.headers['x-lark-verify-token'] || '';
  return token === process.env.LARK_VERIFICATION_TOKEN;
}

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // 1. Xử lý xác minh URL
  if (body.type === 'url_verification') {
    return res.send({ challenge: body.challenge });
  }

  // 2. Kiểm tra verify token
  if (!verifyToken(req)) {
    console.log('[❌] Invalid verify token:', req.headers['x-lark-verify-token']);
    return res.status(401).send('Invalid verify token');
  }

  // 3. Xử lý sự kiện tin nhắn
  const event = body.event;
  if (event && event.message && event.message.content) {
    const userMessage = JSON.parse(event.message.content).text || '';

    try {
      const chat = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Bạn là trợ lý ảo LarkGPT.' },
          { role: 'user', content: userMessage }
        ]
      });

      const aiReply = chat.choices[0].message.content;
      console.log(`[🤖] ${userMessage} → ${aiReply}`);
    } catch (err) {
      console.error('[❌] OpenAI Error:', err.message);
    }
  }

  res.sendStatus(200);
});

// Khởi động server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 Bot is running at http://localhost:${port}`);
});
