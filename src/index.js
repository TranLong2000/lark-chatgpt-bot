// src/index.js

const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

// Lấy biến môi trường (Railway sẽ inject tự động)
const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,
  OPENAI_API_KEY,
} = process.env;

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware để lưu rawBody (cần cho verify hoặc decrypt nếu có)
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

// Khởi tạo Lark client
const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  appType: 'self',                 // hoặc 'internal' nếu app bạn tạo là Internal App
  domain: 'https://open.larksuite.com',
});

// Khởi tạo dispatcher để xử lý webhook event
const dispatcher = new lark.EventDispatcher({
  client,
  verificationToken: LARK_VERIFICATION_TOKEN,
  encryptKey: LARK_ENCRYPT_KEY,    // Nếu bạn không sử dụng webhook encryption, có thể bỏ dòng này
});

// Đăng ký handler cho sự kiện im.message.receive_v1
dispatcher.register({
  'im.message.receive_v1': async (ctx) => {
    const event = ctx.event;
    console.log('>>> Event nhận được:', JSON.stringify(event, null, 2));

    if (!event || !event.message) {
      console.warn('⚠️ event hoặc event.message không tồn tại');
      return;
    }

    // Lấy nội dung text người dùng gửi
    let userText = '[Không có nội dung]';
    try {
      const parsed = JSON.parse(event.message.content || '{}');
      userText = parsed.text || userText;
    } catch (e) {
      console.warn('⚠️ Không parse được event.message.content:', e);
    }
    console.log('🧠 Tin nhắn từ người dùng:', userText);

    // Gọi OpenAI để tạo câu trả lời
    let replyText = 'Bot đang gặp lỗi khi xử lý.';
    try {
      const openaiRes = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Bạn là trợ lý thân thiện.' },
            { role: 'user', content: userText },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      replyText = openaiRes.data.choices[0].message.content;
    } catch (err) {
      console.error('❌ Lỗi khi gọi OpenAI:', err);
    }

    // Trả lời lại trên Lark
    try {
      await client.im.message.reply({
        path: {
          message_id: event.message.message_id,
        },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: replyText }),
        },
      });
      console.log('✅ Đã gửi phản hồi thành công');
    } catch (err) {
      console.error('❌ Lỗi khi gửi phản hồi:', err);
    }
  }
});

// Gắn route /webhook cho dispatcher
app.use('/webhook', lark.adaptExpress(dispatcher, { autoChallenge: true }));

// Một route simple để test server đang chạy
app.get('/', (req, res) => {
  res.send('✅ Bot Lark x OpenAI đang chạy!');
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
