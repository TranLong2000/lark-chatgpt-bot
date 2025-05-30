require('dotenv').config();
const express = require('express');
const { LarkClient } = require('@larksuiteoapi/node-sdk');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Khởi tạo client Lark với domain Lark quốc tế (.com)
const client = new LarkClient({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  baseUrl: process.env.LARK_DOMAIN || 'https://open.larksuite.com',
});

// Khởi tạo OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Xác thực token webhook
function verifyToken(req) {
  const token = req.headers['x-lark-verify-token'] || '';
  return token === process.env.LARK_VERIFICATION_TOKEN;
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

      // Gọi OpenAI tạo phản hồi
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: text },
        ],
      });

      const replyText = completion.choices[0].message.content;

      // Trả lời lại tin nhắn Lark
      await client.im.message.reply({
        message_id,
        content: JSON.stringify({ text: replyText }),
        msg_type: 'text',
      });
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('Error in webhook:', err);
    res.status(500).send('Internal server error');
  }
});

app.listen(PORT, () => {
  console.log(`Lark OpenAI bot running on port ${PORT}`);
});
