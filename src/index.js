// src/index.js
const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');

const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY, // Chỉ cần nếu bạn bật Encrypt Payload
} = process.env;

const app = express();

// Cần để parse raw body khi sử dụng adaptExpress
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// 1. Khởi tạo Lark Client và Event Dispatcher
const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com',
});

const eventDispatcher = new lark.EventDispatcher({
  client,
  verificationToken: LARK_VERIFICATION_TOKEN,
  encryptKey: LARK_ENCRYPT_KEY,
}).register({
  'message.receive_v1': async ({ event }) => {
    try {
      // Lark gửi content dưới dạng JSON string → cần parse
      const rawContent = event.message.content || '{}';
      const parsed = JSON.parse(rawContent);
      const text = parsed.text || '[Không có nội dung]';

      console.log('Tin nhắn nhận được:', text);

      // Trả lời lại tin nhắn
      return {
        msg_type: 'text',
        content: {
          text: `Bạn vừa gửi: ${text}`,
        },
      };
    } catch (err) {
      console.error('Lỗi khi xử lý tin nhắn:', err);
      return null;
    }
  },
});

// 2. Đăng ký middleware webhook
app.use(
  '/webhook',
  lark.adaptExpress(eventDispatcher, { autoChallenge: true })
);

// 3. Endpoint kiểm tra server
app.get('/', (req, res) => {
  res.send('✅ Lark Bot server đang chạy!');
});

// 4. Lắng nghe cổng
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
