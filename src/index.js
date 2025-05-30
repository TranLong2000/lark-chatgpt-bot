const express = require('express');
const { Client, createLogger } = require('@larksuiteoapi/node-sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self',
  domain: process.env.LARK_DOMAIN || 'https://open.larksuite.com',
  logger: createLogger({ level: 'info' }), // dùng chuỗi thay vì LogLevel.INFO
});

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;

    console.log('=== Webhook payload ===');
    console.log(JSON.stringify(payload, null, 2));

    if (!payload || !payload.event) {
      console.warn('⚠️ event hoặc event.message không tồn tại');
      return res.sendStatus(200);
    }

    const event = payload.event;
    const message = event.message;

    if (!message || !message.content) {
      console.warn('⚠️ Không có nội dung tin nhắn');
      return res.sendStatus(200);
    }

    const userMessage = JSON.parse(message.content).text || '';
    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const aiReply = openaiRes.data.choices[0].message.content;

    await client.im.message.reply({
      path: {
        message_id: message.message_id,
      },
      data: {
        content: JSON.stringify({ text: aiReply }),
        msg_type: 'text',
      },
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Lỗi xử lý webhook:', error);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
