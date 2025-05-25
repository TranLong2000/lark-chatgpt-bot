const express = require('express');
const { Lark, Dispatcher } = require('@larksuiteoapi/node-sdk');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const lark = new Lark({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  // domain: 'https://open.larksuite.com',
});

const dispatcher = new Dispatcher(lark);

dispatcher.registerMessageEvent(async (ctx) => {
  console.log('Nhận message:', ctx.event.message.text);
  await ctx.sendText(`Bạn vừa gửi: ${ctx.event.message.text}`);
});

app.post('/webhook', async (req, res) => {
  try {
    await dispatcher.dispatch(req, res);
  } catch (error) {
    console.error('Lỗi khi xử lý webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
});
