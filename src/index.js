require('dotenv').config();
const express = require('express');
const { Client, DefaultLogger } = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

const app = express();
app.use(express.json());

const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  logger: new DefaultLogger(),  // Không truyền level
});

const eventDispatcher = client.eventDispatcher;

eventDispatcher.on('im.message.receive_v1', async (data) => {
  try {
    console.log('>>> Sự kiện nhận được:', JSON.stringify(data, null, 2));

    const event = data?.event;
    if (!event || !event.message) {
      console.warn('⚠️ event hoặc event.message không tồn tại');
      return;
    }

    const messageId = event.message.message_id;
    const messageContentStr = event.message.content;

    const messageContent = JSON.parse(messageContentStr);
    const userMessage = messageContent?.text?.trim();

    if (!userMessage) {
      console.warn('⚠️ Không lấy được nội dung tin nhắn');
      return;
    }

    console.log(`📩 Người dùng gửi: ${userMessage}`);

    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const botReply = openaiRes.data.choices[0].message.content;
    console.log('🤖 Phản hồi từ ChatGPT:', botReply);

    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: botReply }),
        msg_type: 'text',
      },
    });
  } catch (error) {
    console.error('❌ Lỗi xử lý message:', error.message);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    await eventDispatcher.handle(req, res);
  } catch (err) {
    console.error('❌ Lỗi xử lý webhook:', err.message);
    res.status(500).send('Webhook error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
