// src/index.js
const express = require('express');
const { Client, DefaultLogger, LogLevel } = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

const app = express();
app.use(express.json());

// Tạo client Lark
const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  logger: new DefaultLogger({ level: LogLevel.INFO }),
});

// Tạo dispatcher để xử lý sự kiện
const dispatcher = client.eventDispatcher;

// Đăng ký handler cho sự kiện tin nhắn
dispatcher.register('im.message.receive_v1', async (ctx) => {
  try {
    const event = ctx.request.body.event;

    console.log('>>> Event nhận được:', JSON.stringify(event, null, 2));

    if (!event || !event.message) {
      console.warn('⚠️ event hoặc event.message không tồn tại');
      return;
    }

    const messageId = event.message.message_id;
    const messageText = event.message.content;

    const userMessage = JSON.parse(messageText).text?.trim();
    if (!userMessage) {
      console.log('Không tìm thấy nội dung tin nhắn');
      return;
    }

    console.log(`📩 Người dùng gửi: ${userMessage}`);

    // Gửi tới OpenAI ChatGPT
    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const botReply = openaiRes.data.choices[0].message.content.trim();

    console.log(`🤖 ChatGPT trả lời: ${botReply}`);

    // Gửi lại tin nhắn tới Lark
    await client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify({ text: botReply }),
        msg_type: 'text',
      },
    });
  } catch (error) {
    console.error('❌ Lỗi xử lý message:', error);
  }
});

// Gắn webhook cho Express
app.post('/webhook', async (req, res) => {
  await dispatcher.dispatch(req, res);
});

// Khởi chạy server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
