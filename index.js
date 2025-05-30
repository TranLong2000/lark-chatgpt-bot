require('dotenv').config();
const express = require('express');
const { Configuration, OpenAIApi } = require('openai');

const app = express();
app.use(express.json());

const openai = new OpenAIApi(
  new Configuration({ apiKey: process.env.OPENAI_API_KEY })
);

function verifyToken(req) {
  const token = req.headers['x-lark-verify-token'] || '';
  return token === process.env.LARK_VERIFICATION_TOKEN;
}

app.post('/webhook', async (req, res) => {
  // Xác minh token
  if (!verifyToken(req)) {
    console.log('[❌] Invalid verify token:', req.headers['x-lark-verify-token']);
    return res.status(401).send('Invalid verify token');
  }

  // Ping check từ Lark (URL Verification)
  if (req.body.type === 'url_verification') {
    return res.send({ challenge: req.body.challenge });
  }

  // Nhận tin nhắn từ người dùng
  const event = req.body.event;
  if (event && event.message && event.message.content) {
    const userMessage = JSON.parse(event.message.content).text || '';

    try {
      const aiResponse = await openai.createChatCompletion({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Bạn là một trợ lý ảo thân thiện.' },
          { role: 'user', content: userMessage }
        ]
      });

      const reply = aiResponse.data.choices[0].message.content;

      // In log thay vì reply (vì bạn chưa tích hợp message reply API)
      console.log(`[🤖] Trả lời cho "${userMessage}":\n${reply}`);
    } catch (err) {
      console.error('[❌] Lỗi OpenAI:', err.message);
    }
  }

  res.sendStatus(200);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 Lark OpenAI bot running on port ${port}`);
});
