const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const { createOpenAPI, createWebsocket } = require('@larksuiteoapi/sdk');
const { Configuration, OpenAIApi } = require('openai');

// Log để debug biến môi trường
console.log('[ENV] VERIFICATION_TOKEN:', process.env.LARK_VERIFICATION_TOKEN);
console.log('[ENV] APP_ID:', process.env.LARK_APP_ID);
console.log('[ENV] APP_SECRET:', process.env.LARK_APP_SECRET);

const app = new Koa();
app.use(bodyParser());

// Init Lark SDK
const client = createOpenAPI({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com'
});

// Init OpenAI SDK
const openai = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_API_KEY
  })
);

// Webhook endpoint
app.use(async (ctx) => {
  const body = ctx.request.body;

  // Xác thực verify token
  if (body.token !== process.env.LARK_VERIFICATION_TOKEN) {
    console.error('[❌] Invalid verify token:', body.token);
    ctx.status = 401;
    ctx.body = 'Unauthorized';
    return;
  }

  // Trả lời challenge khi lần đầu kết nối
  if (body.type === 'url_verification') {
    ctx.body = {
      challenge: body.challenge
    };
    return;
  }

  // Xử lý tin nhắn từ user
  if (body.header && body.header.event_type === 'im.message.receive_v1') {
    const message = body.event.message;
    const content = JSON.parse(message.content);
    const userMessage = content.text;

    console.log('[LARK] User message:', userMessage);

    try {
      // Gửi tới ChatGPT
      const completion = await openai.createChatCompletion({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: userMessage }]
      });

      const reply = completion.data.choices[0].message.content;

      // Gửi trả lời về Lark
      await client.im.message.reply({
        path: {
          message_id: message.message_id
        },
        data: {
          content: JSON.stringify({ text: reply }),
          msg_type: 'text'
        }
      });

      console.log('[✅] Sent reply to user');
    } catch (err) {
      console.error('[❌] Error sending reply:', err);
    }

    ctx.status = 200;
    ctx.body = 'OK';
    return;
  }

  ctx.status = 200;
  ctx.body = 'OK';
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
