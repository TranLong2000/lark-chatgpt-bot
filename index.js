require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function verifyToken(req) {
  const token = req.headers['x-lark-verify-token'] || '';
  return token === process.env.LARK_VERIFICATION_TOKEN;
}

app.post('/webhook', async (req, res) => {
  // ✅ Bước 1: xử lý URL Verification trước
  if (req.body.type === 'url_verification') {
    return res.send({ challenge: req.body.challenge });
  }

  // ✅ Bước 2: kiểm tra token với các event
  if (!verifyToken(req)) {
    console.log('[❌] Invalid verify token:', req.headers['x-lark-verify-token']);
    return res.status(401).send('Invalid verify token');
  }

  const event = req.body.event;
  if (event && event.message && event.message.content) {
    const userMessage = JSON.parse(event.message.content).text || '';

    try {
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Bạn là một trợ lý ảo thân thiện.' },
          { role: 'user', content: userMessage }
        ]
      });

      const reply = aiResponse.choices[0].message.content;
      console.log(`[🤖] Trả lời cho "${userMessage}":\n${reply}`);
    } catch (err) {
      console.error('[❌] Lỗi OpenAI:', err.message);
    }
  }

  res.sendStatus(200);
});

const port = process.env.PORT |
