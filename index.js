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

// Tạo Lark client
const client = createClient({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
});

// Tạo Gemini model
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

// Map để lưu trạng thái hội thoại của từng user
const chatSessions = new Map();

router.post('/webhook', async (ctx) => {
  const { challenge, event } = ctx.request.body;

  // Trả về challenge để xác minh webhook
  if (challenge) {
    ctx.body = { challenge };
    return;
  }

  // Xử lý sự kiện message
  if (event && event.message) {
    const messageText = event.message.content;
    const userId = event.sender.sender_id.user_id;

    try {
      // Lấy hoặc tạo phiên hội thoại cho user
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

      // Gửi câu hỏi người dùng vào hội thoại
      const result = await chat.sendMessage(messageText);
      const reply = result.response.text();

      // Gửi phản hồi lại cho người dùng qua Lark
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
