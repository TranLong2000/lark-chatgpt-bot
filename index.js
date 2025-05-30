import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import { LarkClient } from '@larksuiteoapi/node-sdk';
import { Configuration, OpenAIApi } from 'openai';

const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,
  OPENAI_API_KEY,
} = process.env;

if (!LARK_APP_ID || !LARK_APP_SECRET || !LARK_VERIFICATION_TOKEN || !LARK_ENCRYPT_KEY || !OPENAI_API_KEY) {
  console.error('[❌] Missing environment variables!');
  process.exit(1);
}

const app = new Koa();
app.use(bodyParser());

// Khởi tạo client Lark
const client = new LarkClient({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  verificationToken: LARK_VERIFICATION_TOKEN,
  encryptKey: LARK_ENCRYPT_KEY,
});

// Khởi tạo OpenAI client
const openai = new OpenAIApi(
  new Configuration({
    apiKey: OPENAI_API_KEY,
  }),
);

app.use(async (ctx) => {
  if (ctx.method === 'POST' && ctx.path === '/webhook') {
    const data = ctx.request.body;

    // Verify token
    if (data.token !== LARK_VERIFICATION_TOKEN) {
      console.log('[❌] Invalid verify token:', data.token);
      ctx.status = 401;
      ctx.body = 'Invalid verify token';
      return;
    }

    // Trả về 200 ngay khi nhận event để tránh Lark retry
    ctx.status = 200;
    ctx.body = 'ok';

    // Chỉ xử lý event tin nhắn nhận được
    if (data.type === 'im.message.receive_v1') {
      const { message, open_id } = data.event;
      if (!message || message.message_type !== 'text') return;

      // Gọi OpenAI để trả lời
      try {
        const completion = await openai.createChatCompletion({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: message.text }],
        });

        const replyText = completion.data.choices[0].message.content;

        // Gửi lại tin nhắn qua Lark API
        await client.im.message.reply({
          msg_type: 'text',
          content: JSON.stringify({ text: replyText }),
          receive_id: message.message_id,
        });
      } catch (error) {
        console.error('[❌] OpenAI or Lark API error:', error);
      }
    }
  } else {
    ctx.status = 404;
    ctx.body = 'Not Found';
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`[info] Server started on port ${port}`);
});
