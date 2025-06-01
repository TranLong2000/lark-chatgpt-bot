import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import dotenv from 'dotenv';
import { Client } from '@larksuiteoapi/node-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const app = new Koa();
const router = new Router();

// Tạo client cho Lark
const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self',
  domain: process.env.LARK_DOMAIN || 'https://open.larksuite.com',
});

// Tạo model Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

// Lưu session hội thoại theo user
const chatSessions = new Map();

router.post('/webhook', async (ctx) => {
  const { challenge, event } = ctx.request.body;

  if (challenge) {
    ctx.body = { challenge };
    return;
  }

  if (event && event.message) {
    const messageText = event.message.content;
    const userId = event.sender.sender_id.user_id;

    try {
      // Tạo hoặc lấy hội thoại của user
      let chat = chatSessions.get(userId);
      if (!chat) {
        chat = model.startChat({
          history: [
            {
              role: 'system',
              parts: [{ text: 'Bạn là trợ lý AI của Lark.' }],
            },
          ],
        });
        chatSessions.set(userId, chat);
      }

      const result = await chat.sendMessage(messageText);
      const reply = result.response.text();

      // Gửi phản hồi lại cho người dùng
      await client.im.message.create({
        receive_id_type: 'user_id',
        body: {
          receive_id: userId,
          msg_type: 'text',
          content: JSON.stringify({ text: reply }),
        },
      });

      ctx.status = 200;
      ctx.body = 'OK';
    } catch (err) {
      console.error('❌ Gemini Error:', err);
      ctx.status = 500;
      ctx.body = 'Internal Server Error';
    }
  } else {
    ctx.status = 400;
    ctx.body = 'Bad Request';
  }
});

app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
