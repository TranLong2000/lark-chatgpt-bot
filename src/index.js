const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');

const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY, // có thể để trống nếu không dùng encryption
} = process.env;

const app = express();

// Middleware parse JSON và lưu raw body cho Lark SDK xử lý
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

// 1. Khởi tạo client SDK
const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com',
});

// 2. Khởi tạo Event Dispatcher và đăng ký xử lý message.receive_v1
const eventDispatcher = new lark.EventDispatcher({
  client,
  verificationToken: LARK_VERIFICATION_TOKEN,
  encryptKey: LARK_ENCRYPT_KEY,
}).register({
  'message.receive_v1': async ({ event }) => {
    try {
      // Lấy nội dung tin nhắn
      const rawContent = event.message.content || '{}';
      const parsed = JSON.parse(rawContent);
      const text = parsed.text || '[Không có nội dung]';

      console.log('📩 Tin nhắn nhận được:', text);

      // Gửi lại phản hồi cho tin nhắn đó
      await client.im.message.reply({
        path: {
          message_id: event.message.message_id,
        },
        data: {
          msg_type: 'text',
          content: JSON.stringify({
            text: `Bạn vừa gửi: ${text}`,
          }),
        },
      });
    } catch (err) {
      console.error('❌ Lỗi khi xử lý message.receive_v1:', err);
    }
  },
});

// 3. Gắn middleware webhook
app.use(
  '/webhook',
  lark.adaptExpress(eventDispatcher, { autoChallenge: true }) // xử lý verify URL
);

// 4. Route test
app.get('/', (req, res) => {
  res.send('✅ Lark Bot server đang chạy!');
});

// 5. Chạy server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
