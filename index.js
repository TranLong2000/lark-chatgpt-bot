import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';

const app = new Koa();
const router = new Router();

const verifyToken = process.env.LARK_VERIFICATION_TOKEN || 'VGe82LO24Vl8HjmBlHtPNcbkpFpujLSX'; // Thay token thật nếu cần test hardcode

router.post('/webhook', async (ctx) => {
  const tokenFromHeader = ctx.headers['x-lark-request-token'];

  console.log('--- WEBHOOK RECEIVED ---');
  console.log('Expected verify token:', verifyToken);
  console.log('Received token from header:', tokenFromHeader);
  console.log('Request body:', ctx.request.body);

  if (!tokenFromHeader) {
    console.log('[❌] Missing verify token in header!');
    ctx.status = 401;
    ctx.body = '[❌] Missing verify token';
    return;
  }

  if (tokenFromHeader !== verifyToken) {
    console.log('[❌] Invalid verify token:', tokenFromHeader);
    ctx.status = 401;
    ctx.body = '[❌] Invalid verify token: ' + tokenFromHeader;
    return;
  }

  // Xử lý sự kiện từ Lark ở đây
  ctx.status = 200;
  ctx.body = 'ok';
});

app.use(bodyParser());
app.use(router.routes()).use(router.allowedMethods());

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
