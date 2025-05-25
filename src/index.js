const express = require('express');
const larksuite = require('@larksuiteoapi/node-sdk');
const { createClient, Dispatcher } = larksuite;

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Tạo Lark client
const lark = createClient({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  // domain: 'https://open.larksuite.com',
});

// Khởi tạo Dispatcher
const dispatcher = new Dispatcher(lark);

// Đăng ký sự kiện message
dispatcher.registerMessageEvent(async (ctx) => {
  console.log('Nhận message:', ctx.event.message.text);
  await ctx.sendText(`Bạn vừa gửi: ${ctx.event.message.text}`);
});

// Webhook route
app.post('/webhook', async (req, res) => {
  try {
    await dispatcher.dispatch(req, res);
  } catch (error) {
    console.error('Lỗi xử lý webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
});
