require('dotenv').config();
const express = require('express');
const { Client, Config, Domain } = require('@larksuiteoapi/node-sdk');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Khởi tạo Lark client cho Lark Việt Nam với domain tùy chỉnh
const config = new Config({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  baseUrl: process.env.LARK_DOMAIN || 'https://open.larksuite.vn',
});
const client = new Client(config);

// Khởi tạo OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Hàm verify token từ header để bảo mật webhook
function verifyToken(req) {
  const token = req.headers['x-lark-verify-token'] || '';
  return token === process.env.LARK_VERIFICATION_TOKEN;
}

// Xử lý webhook Lark
app.post('/webhook', async (req, res) => {
  try {
    if (!verifyToken(req)) {
      return res.status(401).send('Invalid token');
    }

    const event = req.body.event;
    if (!event) {
      return res.status(400).send('No event data');
    }

    // Chỉ xử lý sự kiện message nhận (im.message.receive_v1)
    if (event.type === 'im.message.receive_v1') {
      const { message } = event;
      const { text, message_id } = message;

      // Gọi OpenAI để tạo phản hồi chat
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: text },
        ],
      });

      const replyText = completion.choices[0].message.content;

      // Trả lời lại tin nhắn trên Lark
      await client.im.message.reply({
        path: { message_id },
        data: {
          content: JSON.stringify({ text: replyText }),
          msg_type: 'text',
        },
      });
    }

    res.status(200).send('ok');
  } catch (error) {
    console.error('Error handling webhook:', error);
    res.status(500).send('Internal server error');
  }
});

app.listen(PORT, () => {
  console.log(`Lark OpenAI bot listening on port ${PORT}`);
});
