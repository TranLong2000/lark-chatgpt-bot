const express = require('express');
const { Client, EventDispatcher } = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json({
  // Cho phép đọc raw body để SDK verify signature nếu cần
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Đọc các biến môi trường
const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,        // nếu bạn bật mã hoá trong Lark Console
} = process.env;

console.log('Env:', { LARK_APP_ID, LARK_APP_SECRET, LARK_VERIFICATION_TOKEN, LARK_ENCRYPT_KEY });

// Khởi tạo Lark Client
const client = new Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com',
});

// Khởi tạo Dispatcher với verify và decrypt config
const dispatcher = new EventDispatcher({
  client,
  verificationToken: LARK_VERIFICATION_TOKEN,
  encryptKey: LARK_ENCRYPT_KEY,
});

// Đăng ký sự kiện tin nhắn
dispatcher.register({
  type: 'message.receive_v1',
  handler: async ({ event }) => {
    const message = event.message;
    console.log('Tin nhắn nhận được:', message);
    return {
      msg_type: 'text',
      content: {
        text: `Bạn vừa gửi: ${message.text || '[Không có nội dung]'}`,
      },
    };
  },
});

// Route chính để Lark gọi webhook
app.post('/webhook', async (req, res) => {
  try {
    // In ra để debug
    console.log('Headers:', {
      'x-lark-request-signature': req.headers['x-lark-request-signature'],
      'x-lark-request-timestamp': req.headers['x-lark-request-timestamp'],
      'x-lark-request-nonce': req.headers['x-lark-request-nonce'],
    });
    console.log('Raw body:', req.rawBody.toString());
    console.log('Parsed body:', req.body);

    // Xử lý URL verification (challenge)
    if (req.body.challenge) {
      console.log('Responding to challenge...');
      return res.status(200).json({ challenge: req.body.challenge });
    }

    // Dispatcher sẽ tự verify signature và decrypt payload nếu cần
    await dispatcher.dispatch(req, res);
  } catch (error) {
    console.error('Lỗi khi xử lý webhook:', error);
    // In stacktrace để debug
    if (error.stack) console.error(error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route health-check
app.get('/', (req, res) => res.send('✅ Lark Bot server đang chạy!'));

// Lắng nghe cổng do Railway cấp
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
