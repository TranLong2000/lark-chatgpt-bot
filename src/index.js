const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

// Load biến môi trường từ Railway hoặc hệ thống
const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,
  OPENAI_API_KEY,
} = process.env;

const app = express();

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com',
});

const dispatcher = new lark.EventDispatcher({
  client,
  verificationToken: LARK_VERIFICATION_TOKEN,
  encryptKey: LARK_ENCRYPT_KEY,
});

dispatcher.register({
  'im.message.receive_v1': async ({ event }) => {
    console.log('>>> Event nhận được:', JSON.stringify(event, null, 2));

    if (!event || !event.message) {
      console.warn('⚠️ event hoặc event.message không tồn tại');
      return;
    }

    try {
      const messageId = event.message.message_id;
      const rawContent = event.message.content || '{}';
      const parsed = JSON.parse(rawContent);
      const userText = parsed.text || '[Không có nội dung]';

      console.log('🧠 Tin nhắn từ người dùng:', userText);

      // Gọi OpenAI Chat Completion API
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

      const replyText = openaiRes.data.choices[0].message.content;

      // Gửi phản hồi lại cho người dùng
      await client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: replyText }),
        },
      });
    } catch (err) {
      console.error('❌ Lỗi xử lý message:', err);
      // Gửi phản hồi lỗi nếu cần
      if (event && event.message && event.message.message_id) {
        try {
          await client.im.message.reply({
            path: {
              message_id: event.message.message_id,
            },
            data: {
              msg_type: 'text',
              content: JSON.stringify({
                text: 'Bot gặp lỗi khi xử lý. Vui lòng thử lại sau.',
              }),
            },
          });
        } catch (err2) {
          console.error('❌ Lỗi gửi phản hồi lỗi:', err2);
        }
      }
    }
  },
});

app.use('/webhook', lark.adaptExpress(dispatcher, { autoChallenge: true }));

app.get('/', (req, res) => res.send('✅ Bot đang chạy với OpenAI!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
