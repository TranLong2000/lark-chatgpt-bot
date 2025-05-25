import express from 'express';
import { Lark, Dispatcher } from '@larksuiteoapi/node-sdk';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Khởi tạo Lark client
const lark = new Lark({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  // Nếu cần, thêm domain:
  // domain: 'https://open.larksuite.com',
});

// Khởi tạo Dispatcher
const dispatcher = new Dispatcher(lark);

// Đăng ký sự kiện message
dispatcher.registerMessageEvent(async (ctx) => {
  console.log('Nhận message:', ctx.event.message.text);

  // Ví dụ trả lời echo message
  await ctx.sendText(`Bạn vừa gửi: ${ctx.event.message.text}`);
});

// Route webhook Lark
app.post('/webhook', async (req, res) => {
  try {
    await dispatcher.dispatch(req, res);
  } catch (error) {
    console.error('Lỗi khi xử lý webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Khởi động server
app.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
});
