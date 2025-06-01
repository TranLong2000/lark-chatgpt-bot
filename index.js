import axios from 'axios';
import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import dotenv from 'dotenv';
dotenv.config();

const app = new Koa();
const router = new Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

router.post('/webhook', async (ctx) => {
  const { text } = ctx.request.body; // giả sử Lark gửi message text ở đây

  // Gọi Gemini API qua REST (ví dụ giả định)
  try {
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText',
      {
        prompt: { text },
        temperature: 0.7,
        candidateCount: 1,
        maxOutputTokens: 1024,
      },
      {
        headers: {
          'Authorization': `Bearer ${GEMINI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const replyText = response.data.candidates[0].output;

    ctx.body = {
      reply: replyText,
    };
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to call Gemini API' };
  }
});

app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
