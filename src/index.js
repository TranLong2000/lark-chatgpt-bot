import express from 'express';
import { Client, EventDispatcher } from '@larksuiteoapi/node-sdk';

// Tạo client Lark
const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  encryptKey: process.env.LARK_ENCRYPT_KEY, // nếu có dùng encryption
  verificationToken: process.env.LARK_VERIFICATION_TOKEN, // Token verify webhook
});

const dispatcher = new EventDispatcher(client);

const app = express();
app.use(express.json()); // parse JSON body bắt buộc

// Middleware verify webhook (nếu bạn có dùng verify token)
app.use((req, res, next) => {
  const token = req.headers['x-lark-signature'] || req.headers['X-Lark-Signature'];
  // Bạn có thể thêm code verify token ở đây nếu cần
  next();
});

// Route webhook nhận event
app.post('/webhook', async (req, res) => {
  console.log('=== Full webhook payload ===');
  console.log(JSON.stringify(req.body, null, 2));

  const { event } = req.body;

  if (!event || !event.message) {
    console.warn('⚠️ event hoặc event.message không tồn tại');
    return res.status(200).send('ok');
  }

  try {
    // Xử lý message nhận được
    console.log('>>> Message nhận được:', event.message);

    // Ví dụ gửi reply đơn giản (bạn cần dùng client để gửi message trả lời)
    // await client.im.message.reply({
    //   message_id: event.message.message_id,
    //   content: JSON.stringify({ text: 'Xin chào từ bot!' }),
    // });

    // Trả response nhanh cho Lark
    return res.status(200).send('ok');
  } catch (error) {
    console.error('Lỗi xử lý message:', error);
    return res.status(500).send('error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
