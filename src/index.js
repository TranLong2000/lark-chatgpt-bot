// src/index.js
const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');

const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,        // chỉ nếu bạn bật tính năng Encrypt Payload
} = process.env;

const app = express();
// express.json() vẫn cần để parse body trước khi adaptExpress
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// 1. Khởi tạo client và dispatcher
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
    const text = event.message.text || '[Không có nội dung]';
    console.log('Tin nhắn nhận được:', text);
    return {
      msg_type: 'text',
      content: { text: `Bạn vừa gửi: ${text}` },
    };
  },
});

// 2. Gắn middleware adaptExpress cho đường dẫn /webhook
//    autoChallenge: true sẽ tự phản hồi challenge khi Lark verify URL
app.use(
  '/webhook',
  lark.adaptExpress(eventDispatcher, { autoChallenge: true })
);

// 3. Route kiểm tra server
app.get('/', (req, res) => res.send('✅ Lark Bot server đang chạy!'));

// 4. Lắng nghe cổng do Railway cấp
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
