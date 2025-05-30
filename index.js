import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import crypto from 'crypto';
import { OpenAI } from 'openai';

const app = new Koa();
const router = new Router();

const PORT = process.env.PORT || 8080;

// 🔐 Load env
const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 🤖 Init OpenAI
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// 🔓 Hàm giải mã dữ liệu Lark gửi tới
function decryptLark(encrypt) {
  const key = crypto.createHash('sha256').update(ENCRYPT_KEY).digest();
  const encryptedData = Buffer.from(encrypt, 'base64');
  const iv = encryptedData.subarray(0, 16);
  const data = encryptedData.subarray(16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(data);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return JSON.parse(decrypted.toString());
}

// 🧩 Webhook Endpoint
router.post('/webhook', async (ctx) => {
  const body = ctx.request.body;

  if (!body.encrypt) {
    ctx.status = 400;
    ctx.body = 'Missing encrypted content';
    return;
  }

  const decrypted = decryptLark(body.encrypt);
  console.log('[📨] Event received:', decrypted);

  const { schema, header, event } = decrypted;

  // ✨ Trả lời thử nếu nhận message
  if (header.event_type === 'im.message.receive_v1') {
    const userMessage = 'Hi, this is a test message!'; // bạn có thể parse event ở đây

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: userMessage }],
    });

    const reply = completion.choices[0].message.content;
    console.log('🧠 GPT response:', reply);
    // TODO: Gửi ngược lại người dùng bằng Lark SDK nếu muốn
  }

  ctx.body = { code: 0, msg: 'ok' }; // ✅ Lark cần status 200 và body này
});

app.use(bodyParser());
app.use(router.routes()).use(router.allowedMethods());

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
