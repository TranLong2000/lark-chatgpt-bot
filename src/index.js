const express = require('express');
const { Client, EventDispatcher } = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json());

const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self', // hoặc 'custom' nếu bạn đăng ký kiểu khác
  domain: 'https://open.larksuite.com',
});

const dispatcher = new EventDispatcher({ client });

// Đăng ký sự kiện tin nhắn
dispatcher.register({
  type: 'message.receive_v1',
  handler: async (data) => {
    const message = data.event.message;
    console.log('Tin nhắn nhận được:', message);
    // có thể phản hồi tại đây nếu muốn
  },
});

app.post('/webhook', async (req, res) => {
  await dispatcher.dispatch(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot Lark đang chạy tại http://localhost:${PORT}`);
});
