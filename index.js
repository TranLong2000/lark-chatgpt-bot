import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import dotenv from 'dotenv';
import larkSDK from '@larksuiteoapi/node-sdk'; // 👈 import default
import { OpenAI } from 'openai';

dotenv.config();

const { createClient } = larkSDK; // 👈 lấy hàm từ object default

const app = new Koa();
const router = new Router();

const client = createClient({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

router.post('/webhook', async (ctx) => {
  const { challenge, header, event } = ctx.request.body;

  // Trả về challenge nếu có (xác minh webhook lần đầu)
  if (challenge) {
    ctx.body = { challenge };
    return;
  }

  if (event && event.message) {
    const messageText = event.message.content;
    const userId = event.sender.sender_id.user_id;

    try {
      const chatCompletion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'Bạn là trợ lý AI của Lark.' },
          { role: 'user', content: messageText },
        ],
      });

      const reply = chatCompletion.choices[0].message.content;

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
      console.error('❌ OpenAI Error:', err);
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
