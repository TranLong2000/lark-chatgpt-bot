require('dotenv').config();
const express = require('express');
const { Client } = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

const app = express();
app.use(express.json());

// Khởi tạo client Lark
const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
});

// Lấy event dispatcher
const eventDispatcher = client.eventDispatcher;

// Debug log
console.info('[info]: client ready');
console.info('[info]: event-dispatch is ready');

app.post('/webhook', async (req, res) => {
  const { event } = req.body;
  console.log('>>> Event nhận được:', event);

  // Kiểm tra event và message
  if (!event || !event.message) {
    console.warn('⚠️ event hoặc event.message không tồn tại');
    return res.status(200).send('ok');
  }

  try {
    const { message } = event;
    const chatId = message.chat_id;
    const userId = message.user_id;
    const text = message.text;

    // Gọi OpenAI API (ví dụ)
    const openaiResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: text }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const replyText = openaiResponse.data.choices[0].message.content;

    // Gửi trả lời vào chat
    await client.im.message.create({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: replyText }),
    });

    res.status(200).send('ok');
  } catch (error) {
    console.error('❌ Lỗi xử lý message:', error);
    res.status(500).send('error');
  }
});

// Bắt đầu server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
