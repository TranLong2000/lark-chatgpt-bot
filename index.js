import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import axios from 'axios';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const app = new Koa();
const router = new Router();
const PORT = process.env.PORT || 8080;

// Init OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Get tenant access token
let tenantToken = null;
async function getTenantAccessToken() {
  const res = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  tenantToken = res.data.tenant_access_token;
  console.log('[✅] Tenant token acquired.');
}
await getTenantAccessToken();

// Handle Lark webhook
router.post('/webhook', async (ctx) => {
  const event = ctx.request.body;

  // Decrypt (Lark may send encrypted data — skip for now if plaintext)
  const message = event.event?.message;
  if (!message) {
    ctx.status = 400;
    ctx.body = 'No message received';
    return;
  }

  const userMessage = message.content ? JSON.parse(message.content).text : '';
  const chatId = message.chat_id;

  console.log('🔹 User message:', userMessage);

  // Send message to OpenAI
  try {
    const completion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: userMessage }],
      model: 'gpt-4',
    });

    const botReply = completion.choices[0].message.content;

    // Reply to user
    await axios.post(
      'https://open.larksuite.com/open-apis/im/v1/messages',
      {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: botReply }),
      },
      {
        headers: {
          Authorization: `Bearer ${tenantToken}`,
          'Content-Type': 'application/json',
        },
        params: {
          receive_id_type: 'chat_id',
        },
      }
    );

    ctx.status = 200;
    ctx.body = 'OK';
  } catch (err) {
    console.error('❌ OpenAI or Lark error:', err.message);
    ctx.status = 500;
    ctx.body = 'Internal error';
  }
});

app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
