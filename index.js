import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import dotenv from 'dotenv';
import { Client, createLarkMiddleware } from '@larksuiteoapi/node-sdk';
import OpenAI from 'openai';

dotenv.config();

// Khởi tạo Lark client
const larkClient = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  disableTokenCache: false,
  domain: 'https://open.larksuite.com',
});

// Khởi tạo OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Tạo app Koa
const app = new Koa();
const router = new Router();

// Xử lý webhook từ Lark
router.post('/webhook', createLarkMiddleware({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  encryptKey: process.env.LARK_ENCRYPT_KEY,
  verificationToken: process.env.LARK_VERIFICATION_TOKEN,
  eventHandler: async (event) => {
    console.log('[✅] Event received:', JSON.stringify(event, null, 2));

    if (event.header.event_type === 'im.message.receive_v1') {
      const messageId = event.event.message.message_id;
      const content = JSON.parse(event.event.message.content);
      const userMessage = content.text;

      console.log('User message:', userMessage);

      try {
        const aiResponse = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Bạn là trợ lý AI.' },
            { role: 'user', content: userMessage }
          ],
        });

        const reply = aiResponse.choices[0].message.content;

        await larkClient.im.message.reply({
          path: {
            message_id: messageId,
          },
          data: {
            content: JSON.stringify({ text: reply }),
            msg_type: 'text',
          },
        });

        console.log('[✅] Replied to message');
      } catch (err) {
        console.error('[❌] Error while calling OpenAI or replying:', err);
      }
    }
  },
}));

// Middleware
app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
