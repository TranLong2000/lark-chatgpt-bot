import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';

const app = new Koa();
const router = new Router();

const VERIFY_TOKEN = process.env.LARK_VERIFICATION_TOKEN || 'VGe82LO24Vl8HjmBlHtPNcbkpFpujLSX';

router.post('/webhook', async (ctx) => {
  const verifyToken = ctx.headers['x-lark-verify-token'];
  console.log('Expected verify token:', VERIFY_TOKEN);
  console.log('Received token from header:', verifyToken);

  if (!verifyToken) {
    console.error('[❌] Missing verify token in header!');
    ctx.status = 401;
    ctx.body = 'Missing verify token';
    return;
  }

  if (verifyToken !== VERIFY_TOKEN) {
    console.error('[❌] Invalid verify token:', verifyToken);
    ctx.status = 401;
    ctx.body = 'Invalid verify token';
    return;
  }

  // Xử lý payload webhook ở đây
  const payload = ctx.request.body;
  console.log('Webhook payload:', payload);

  ctx.body = 'ok';
});

app.use(bodyParser());
app.use(router.routes()).use(router.allowedMethods());

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
