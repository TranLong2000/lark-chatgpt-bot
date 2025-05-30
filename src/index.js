const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

// Chỉ load .env khi không chạy production (Railway đã inject env sẵn)
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

const dispatcher = new lark.EventDispatcher({
  client,
  verificationToken: LARK_VERIFICATION_TOKEN,
  encryptKey: LARK_ENCRYPT_KEY,
}).register({
  'im.message.receive_v1': async (params) => {
    const event = params.event;

    try {
      console.log('>>> Event nhận được:', JSON.stringify(event, null, 2));

      if (!event || !event.message) {
        console.warn('⚠️ event hoặc event.message không tồn tại');
        return;
      }

      let userText = '[Không có nội dung]';
      try {
        const parsed = JSON.parse(event.message.content);
        userText = parsed.text || userText;
      } catch {
        console.warn('⚠️ Không parse được event.message.content');
      }

      console.log('🧠 Tin nhắn từ người dùng:', userText);

      // Lấy tenant access token
      const tokenRes = await client.tenantAccessToken.get();
      const tenantAccessToken = tokenRes.tenant_access_token;

      // Gọi OpenAI Chat Completion
      const openaiRes = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Bạn là trợ lý thân thiện.' },
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

      // Gửi phản hồi đến user
      await client.im.message.create({
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
        },
        params: {
          receive_id_type: 'user_id',
        },
        data: {
          receive_id: event.sender.sender_id.user_id,
          msg_type: 'text',
          content: JSON.stringify({ text: replyText }),
        },
      });

      console.log('✅ Đã gửi phản hồi thành công');
    } catch (err) {
      console.error('❌ Lỗi xử lý message:', err);
    }
  },
});

app.use('/webhook', lark.adaptExpress(dispatcher, { autoChallenge: true }));

app.get('/', (req, res) => {
  res.send('✅ Bot Lark x OpenAI đang chạy');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
