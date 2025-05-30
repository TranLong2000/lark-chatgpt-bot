const express = require('express'); 
const lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

// Load dotenv khi chưa phải production
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
      console.log('>>> Đã nhận event im.message.receive_v1');
      console.log('Event:', JSON.stringify(event));

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

      // Lấy Tenant Access Token để gửi tin nhắn
      const tokenRes = await client.tenantAccessToken.get();
      const tenantAccessToken = tokenRes.tenant_access_token;

      // Gửi lại phản hồi đến người dùng trên Lark
      await client.im.message.create({
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
        },
        data: {
          receive_id_type: 'user_id',
          receive_id: event.sender.sender_id.user_id,
          content: JSON.stringify({
            text: replyText,
          }),
          msg_type: 'text',
        },
      });

      console.log('✅ Đã gửi phản hồi thành công');

    } catch (err) {
      console.error('❌ Lỗi xử lý message:', err);

      try {
        // Lấy tenant token để gửi message lỗi
        const tokenRes = await client.tenantAccessToken.get();
        const tenantAccessToken = tokenRes.tenant_access_token;

        await client.im.message.create({
          headers: {
            Authorization: `Bearer ${tenantAccessToken}`,
          },
          data: {
            receive_id_type: 'user_id',
            receive_id: event.sender.sender_id.user_id,
            content: JSON.stringify({
              text: 'Bot gặp lỗi khi xử lý. Vui lòng thử lại sau.',
            }),
            msg_type: 'text',
          },
        });
      } catch (error) {
        console.error('❌ Lỗi gửi phản hồi lỗi:', error);
      }
    }
  },
});

app.use('/webhook', lark.adaptExpress(dispatcher, { autoChallenge: true }));

app.get('/', (req, res) => res.send('✅ Bot đang chạy với OpenAI!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại cổng ${PORT}`);
});
