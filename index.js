const express = require('express');
const bodyParser = require('body-parser');
const { default: LarkClient, EVENT } = require('@larksuiteoapi/node-sdk');
const { OpenAI } = require('openai');

require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// Khởi tạo Lark Client
const client = new LarkClient({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  encryptKey: process.env.LARK_ENCRYPT_KEY,
  verificationToken: process.env.LARK_VERIFICATION_TOKEN,
  domain: process.env.LARK_DOMAIN || 'https://open.larksuite.com',
});

// Khởi tạo OpenAI Client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Webhook xử lý tin nhắn
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Xác thực token
  if (body.token !== process.env.LARK_VERIFICATION_TOKEN) {
    console.error('[❌] Invalid verify token:', body.token);
    return res.status(401).send('Unauthorized');
  }

  // Xử lý challenge verification
  if (body.type === 'url_verification') {
    return res.send({ challenge: body.challenge });
  }

  // Xử lý message event
  if (body.header && body.header.event_type === 'im.message.receive_v1') {
    const message = body.event.message;
    const senderId = body.event.sender.sender_id.user_id;

    const text = JSON.parse(message.content).text;

    try {
      const chatResponse = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: text }],
      });

      const reply = chatResponse.choices[0].message.content;

      await client.im.message.create({
        data: {
          receive_id_type: 'user_id',
          content: JSON.stringify({ text: reply }),
          msg_type: 'text',
          receive_id: senderId,
        },
      });

    } catch (err) {
      console.error('Lỗi GPT hoặc gửi tin nhắn:', err);
    }
  }

  res.status(200).send('OK');
});

// Khởi động server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
