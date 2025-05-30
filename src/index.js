const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

// Chỉ load dotenv khi chạy local
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,
  OPENAI_API_KEY,
} = process.env;

const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com',
});

console.log('[info]: [ client ready ]');

// Đăng ký sự kiện message.receive_v1
const dispatcher = new lark.EventDispatcher({
  client,
  verificationToken: LARK_VERIFICATION_TOKEN,
  encryptKey: LARK_ENCRYPT_KEY,
}).register({
  'im.message.receive_v1': async ({ event }) => {
    console.log('>>> Nhận được event:', JSON.stringify(event, null, 2));

    if (!event || !event.message) {
      console.warn('⚠️ event hoặc event.message không tồn tại');
      return;
    }

    const rawContent = event.message.content || '{}';
    const parsed = JSON.parse(rawContent);
    const userText = parsed.text || '[Không có nội dung]';

    console.log('🧠 Người dùng gửi:', userText);

    try {
      const openaiRes = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Bạn là trợ lý AI thân thiện.' },
            { role: 'user', content: userText }
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

      await client.im.message.reply({
        path: {
          message_id: event.message.message_id,
        },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: replyText }),
        },
      });

    } catch (err) {
      console.error('❌ Lỗi xử lý message:', err);
      // Phản hồi lỗi
      try {
        await client.im.message.reply({
          path: {
            message_id: event.message.message_id,
          },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text: 'Bot gặp lỗi khi xử lý. Vui lòng thử lại sau.' }),
          },
        });
      } catch (e) {
        console.error('❌ Lỗi khi gửi phản hồi lỗi:', e);
      }
    }
  }
});

console.log('[info]: [ event-dispatch is ready ]');

app.use('/webhook', lark.adaptExpress(dispatcher, { autoChallenge: true }));
app.get('/', (req, res) => res.send('✅ Bot đang chạy với OpenAI!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
