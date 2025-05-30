const express = require('express');
const { Client, DefaultLogger } = require('@larksuiteoapi/node-sdk');
require('dotenv').config();

const app = express();
app.use(express.json());

const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self', // nếu là custom app thì dùng 'custom'
  domain: 'https://open.larksuite.com',
  logger: new DefaultLogger(),
  verificationToken: process.env.LARK_VERIFICATION_TOKEN,
  encryptKey: process.env.LARK_ENCRYPT_KEY,
});

console.log('[info]: [client ready]');

app.post('/webhook', async (req, res) => {
  const body = req.body;

  console.log('=== Webhook payload ===');
  console.log(JSON.stringify(body, null, 2));

  let event;
  if (body.encrypt) {
    try {
      const decrypted = client.decrypt(body.encrypt);
      event = JSON.parse(decrypted);
    } catch (err) {
      console.error('❌ Lỗi giải mã payload:', err);
      return res.status(400).send('Decrypt error');
    }
  } else {
    event = body.event;
  }

  console.log('>>> Event nhận được:', event);

  if (!event || !event.message) {
    console.warn('⚠️ event hoặc event.message không tồn tại');
    return res.status(200).send('ok');
  }

  try {
    const message = event.message;
    const senderId = event.sender.sender_id?.user_id;

    console.log(`>>> Message từ ${senderId}:`, message.content);

    // TODO: Gửi phản hồi hoặc xử lý thêm ở đây nếu cần

    return res.status(200).send('ok');
  } catch (err) {
    console.error('❌ Lỗi xử lý sự kiện:', err);
    return res.status(500).send('error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
