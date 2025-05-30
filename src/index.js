// index.js
const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');
require('dotenv').config();

const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,
} = process.env;

const app = express();

// Parse raw body để Lark SDK xử lý verify/challenge
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

// Tạo client
const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com',
});

// Tạo dispatcher và đăng ký event
const dispatcher = new lark.EventDispatcher({
  client,
  verificationToken: LARK_VERIFICATION_TOKEN,
  encryptKey: LARK_ENCRYPT_KEY,
}).register({
  'message.receive_v1': async ({ event }) => {
    try {
      // In ra event để debug
      console.log('📩 Tin nhắn đến:', JSON.stringify(event, null, 2));

      const rawContent = event.message.content || '{}';
      const parsed = JSON.parse(rawContent);
      const text = parsed.text || '[Không có nội dung]';

      // Phản hồi lại tin nhắn
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
      console.error('❌ Lỗi xử lý message:', err);
    }
  },
});

// Gắn webhook
app.use('/webhook', lark.adaptExpress(dispatcher, { autoChallenge: true }));

// Route kiểm tra server sống
app.get('/', (req, res) => {
  res.send('✅ Lark Bot đang chạy!');
});

// Chạy server
const PORT = process.env.POST || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server lắng nghe tại cổng ${PORT}`);
});
