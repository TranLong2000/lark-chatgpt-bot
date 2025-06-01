const express = require('express');
const crypto = require('crypto');

const app = express();

// Middleware giữ raw body dưới dạng string để verify signature
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Hàm verify chữ ký webhook Lark
function verifyLarkSignature(req) {
  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  const signature = req.headers['x-lark-signature'];

  if (!timestamp || !nonce || !signature) {
    console.error('[Verify] Missing required headers');
    return false;
  }

  const strToSign = timestamp + nonce + req.rawBody;
  const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(strToSign);
  const expectedSignature = hmac.digest('hex');

  console.log('[Verify] Expected (hex):', expectedSignature);
  console.log('[Verify] Received:', signature);

  return expectedSignature === signature;
}

app.post('/webhook', (req, res) => {
  console.log('--- New Webhook Request ---');
  console.log('Headers:', req.headers);
  console.log('Body:', req.rawBody);

  if (!verifyLarkSignature(req)) {
    console.error('[Webhook] Invalid signature – stop.');
    return res.status(401).send('Invalid signature');
  }

  // Xử lý webhook event ở đây
  // Ví dụ: trả về 200 OK để xác nhận đã nhận webhook
  res.status(200).send('OK');
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
