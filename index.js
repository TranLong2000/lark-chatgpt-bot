import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import dotenv from 'dotenv';
import lark from '@larksuiteoapi/node-sdk';
import { OpenAI } from 'openai';

dotenv.config();

const app = new Koa();
const router = new Router();

const { createClient } = lark;

const client = createClient({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

router.post('/webhook', async (ctx) => {
  const { challenge, header, event } = ctx.request.body;

  // Trả challenge khi verify
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
      console.error('❌ Error handling message:', err);
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
  console.log(`🚀 Server running on port ${PORT}`);
});
