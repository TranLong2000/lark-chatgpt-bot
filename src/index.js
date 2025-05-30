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
  'im.message.receive_v1': async ({ event }) => {
    try {
      console.log('>>> Received event:', JSON.stringify(event, null, 2));

      let userText = '[Không có nội dung]';

      if (event.message && event.message.content) {
        try {
          const parsed = JSON.parse(event.message.content);
          userText = parsed.text || userText;
        } catch (e) {
          console.warn('⚠️ Không parse được event.message.content:', e);
        }
      } else if (event.text) {
        userText = event.text;
      } else {
        console.warn('⚠️ Không tìm thấy nội dung tin nhắn trong event:', event);
      }

      console.log('🧠 Tin nhắn từ người dùng:', userText);

      // Gọi OpenAI Chat Completion API
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

      // Lấy Tenant Access Token thủ công
      const tokenRes = await client.tenantAccessToken.get();
      const tenantAccessToken = tokenRes.tenant_access_token;

      // Gửi lại phản hồi đến người dùng
      await client.im.message.create({
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
        },
        data: {
          receive_id_type: 'user_id',
          receive_id: event.sender.sender_id.user_id,
          content: JSON.stringify({ text: replyText }),
          msg_type: 'text',
        },
      });

      console.log('✅ Đã gửi phản hồi thành công');

    } catch (err) {
      console.error('❌ Lỗi xử lý message:', err);

      // Gửi phản hồi lỗi (nên kiểm tra client.tenantAccessToken có tồn tại)
      try {
        const tokenRes = await client.tenantAccessToken.get();
        const tenantAccessToken = tokenRes.tenant_access_token;

        await client.im.message.create({
          headers: {
            Authorization: `Bearer ${tenantAccessToken}`,
          },
          data: {
            receive_id_type: 'user_id',
            receive_id: event.sender.sender_id.user_id,
            content: JSON.stringify({ text: 'Bot gặp lỗi khi xử lý. Vui lòng thử lại sau.' }),
            msg_type: 'text',
          },
