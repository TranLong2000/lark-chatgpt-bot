const express = require('express');
const { Client } = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json());

// Khởi tạo client Lark
const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  verificationToken: process.env.LARK_VERIFICATION_TOKEN,
  encryptKey: process.env.LARK_ENCRYPT_KEY,
});

app.post('/webhook', async (req, res) => {
  console.log('=== Webhook payload ===');
  console.log(JSON.stringify(req.body, null, 2));

  const { event } = req.body;

  if (!event || !event.message) {
    console.warn('⚠️ event hoặc event.message không tồn tại');
    return res.status(200).send('ok');
  }

  try {
    console.log('>>> Message nhận được:', event.message);

    // (Tuỳ chọn) Gửi phản hồi về message (nếu cần)
    // await client.im.message.reply({
    //   message_id: event.message.message_id,
    //   content: JSON.stringify({ text: 'Chào bạn!' }),
    // });

    return res.status(200).send('ok');
  } catch (err) {
    console.error('Lỗi xử lý message:', err);
    return res.status(500).send('error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
