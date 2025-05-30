require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/webhook', async (req, res) => {
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);

  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Tạm comment verify token nếu Lark không gửi header
  // const token = req.headers['x-lark-verify-token'];
  // if (!token || token !== process.env.LARK_VERIFICATION_TOKEN) {
  //   console.log('[❌] Invalid verify token:', token);
  //   return res.status(401).send('Invalid verify token');
  // }

  const event = req.body.event;
  if (event && event.message && event.message.content) {
    const userMessage = JSON.parse(event.message.content).text || '';

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Bạn là trợ lý ảo LarkGPT.' },
          { role: 'user', content: userMessage }
        ]
      });

      const reply = completion.choices[0].message.content;
      console.log(`[🤖] User: ${userMessage}\n[🤖] Bot: ${reply}`);
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
