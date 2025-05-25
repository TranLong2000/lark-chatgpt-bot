const express = require('express');
const { LarkClient, Dispatcher } = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json());

const lark = new LarkClient({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  domain: 'https://open.larksuite.com',
});

const dispatcher = new Dispatcher(lark);

// Gửi lại tin nhắn người dùng
dispatcher.registerMessageEvent(async (ctx) => {
  const msg = ctx.event.message.text;
  await ctx.sendText(`Bạn vừa gửi: ${msg}`);
});

app.post('/webhook', async (req, res) => {
  try {
    await dispatcher.dispatch(req, res);
  } catch (err) {
    console.error('Lỗi webhook:', err);
    res.status(500).send('Lỗi server');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot đang chạy tại http://localhost:${PORT}`);
});
