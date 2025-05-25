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

// Đăng ký sự kiện nhận tin nhắn
dispatcher.register({
  type: 'message.receive_v1',
  handler: async (data) => {
    const message = data.event.message;
    console.log('Tin nhắn nhận được:', message);

    return {
      msg_type: 'text',
      content: {
        text: `Bạn vừa gửi: ${message.text || '[Không có nội dung]'}`,
      },
    };
  },
});

// Route webhook chính
app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook received:', JSON.stringify(req.body));

    // Xử lý challenge khi lần đầu khai báo URL
    if (req.body && req.body.challenge) {
      console.log('Responding to challenge...');
      return res.status(200).json({ challenge: req.body.challenge });
    }

    // Dispatch các sự kiện khác
    await dispatcher.dispatch(req, res);
  } catch (error) {
    console.error('Lỗi khi xử lý webhook:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route kiểm tra sống
app.get('/', (req, res) => {
  res.send('✅ Lark Bot server đang chạy!');
});

// Cổng động do Railway cấp (ví dụ 8080)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot đang chạy tại cổng ${PORT}`);
});
