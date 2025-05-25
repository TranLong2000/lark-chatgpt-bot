const express = require('express');
const { Client, EventDispatcher } = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json());

const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com',
});

const dispatcher = new EventDispatcher({ client });

// Đăng ký sự kiện tin nhắn
dispatcher.register({
  type: 'message.receive_v1',
  handler: async (data) => {
    const message = data.event.message;
    console.log('Tin nhắn nhận được:', message);

    // Trả về JSON đúng chuẩn Lark yêu cầu để phản hồi tin nhắn
    return {
      msg_type: 'text',
      content: {
        text: `Bạn vừa gửi: ${message.text || '...'}`,
      },
    };
  },
});

// Route webhook xử lý sự kiện từ Lark
app.post('/webhook', async (req, res) => {
  try {
    await dispatcher.dispatch(req, res);
  } catch (err) {
    console.error('Error dispatching event:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Port mặc định hoặc 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot Lark đang chạy tại http://localhost:${PORT}`);
});
