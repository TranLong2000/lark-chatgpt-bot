import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import dotenv from 'dotenv';
import { createClient } from '@larksuiteoapi/node-sdk';
import OpenAI from 'openai';

dotenv.config();

const app = new Koa();
const router = new Router();
const port = process.env.PORT || 8080;

// Init Lark SDK
const client = createClient({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  domain: 'https://open.feishu.cn'
});

// Init OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Endpoint nhận webhook từ Lark
router.post('/webhook', async (ctx) => {
  const event = ctx.request.body?.event;
  if (event?.message?.content) {
    const content = JSON.parse(event.message.content);
    const text = content.text || '';

    // Gọi OpenAI
    const completion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: text }],
      model: 'gpt-3.5-turbo'
    });

    const reply = completion.choices[0]?.message?.content || 'Không có phản hồi';

    // Gửi lại qua Lark SDK
    await client.im.message.reply({
      path: {
        message_id: event.message.message_id
      },
      data: {
        content: JSON.stringify({ text: reply }),
        msg_type: 'text'
      }
    });
  }

  ctx.body = { code: 0 };
});

app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
