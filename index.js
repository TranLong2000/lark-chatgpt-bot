import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import dotenv from 'dotenv';
import larkSDK from '@larksuiteoapi/node-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const { createClient } = larkSDK;
const app = new Koa();
const router = new Router();

const client = createClient({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

// 👉 Lưu hội thoại theo userId
const chatSessions = new Map(); // userId => chat object

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
      // Lấy hoặc tạo session chat mới
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

      // Gửi tin nhắn người dùng vào hội thoại
      const result = await chat.sendMessage(messageText);
      const reply = result.response.text();

      // Gửi lại cho Lark
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
