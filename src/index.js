const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

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
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com',
});

console.info('[info]: [ \'client ready\' ]');

const dispatcher = new lark.EventDispatcher({
  client,
  verificationToken: LARK_VERIFICATION_TOKEN,
  encryptKey: LARK_ENCRYPT_KEY,
});

console.info('[info]: [ \'event-dispatch is ready\' ]');

dispatcher.register({
  'im.message.receive_v1': async (ctx) => {
    const event = ctx.event;
    console.log('>>> Event nhận được:', JSON.stringify(event, null, 2));

    if (!event || !event.message) {
      console.warn('⚠️ event hoặc event.message không tồn tại');
      return;
    }

    const rawContent = event.message.content || '{}';
    let parsedContent = {};
    try {
      parsedContent = JSON.parse(rawContent);
    } catch (err) {
      console.error('❌ Không thể parse content:', rawContent);
    }

    const userText = parsedContent.text || '[Không có nội dung]';
    console.log('🧠 Tin nhắn từ người dùng:', userText);

    let replyText = 'Bot đang gặp lỗi khi xử lý.';

    try {
      const openaiRes = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Bạn là một trợ lý thân thiện.' },
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
      console.error('❌ Lỗi khi gọi OpenAI:', err.message);
    }

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
    } catch (err) {
      console.error('❌ Lỗi khi gửi phản hồi:', err.message);
    }
  }
});

app.post('/webhook', lark.adaptExpress(dispatcher, { autoChallenge: true }));

app.get('/', (req, res) => {
  res.send('✅ Bot đang chạy!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
