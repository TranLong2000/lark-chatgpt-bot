const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const {
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,
} = process.env;

const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Hàm giải mã dữ liệu nếu có encryptKey
function decryptPayload(encryptKey, encryptData) {
  const key = Buffer.from(encryptKey, 'base64');
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptData, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

app.post('/webhook', (req, res) => {
  try {
    // Nếu có encrypt_key thì webhook body sẽ có encrypted字段
    const body = req.body;

    console.log('Raw body:', body);

    let eventData;

    if (body.encrypt) {
      eventData = decryptPayload(LARK_ENCRYPT_KEY, body.encrypt);
      console.log('Giải mã payload:', eventData);
    } else {
      eventData = body;
      console.log('Payload không mã hóa:', eventData);
    }

    if (eventData && eventData.event && eventData.event.message) {
      console.log('Tin nhắn nhận được:', eventData.event.message);
      // Ở đây bạn có thể xử lý logic gọi OpenAI, trả lời tin nhắn
      // Tạm thời trả về "OK" để Lark biết webhook đã nhận
      res.status(200).send('OK');
    } else {
      console.warn('Không có event.message trong payload');
      res.status(400).send('No message event');
    }
  } catch (err) {
    console.error('Lỗi khi xử lý webhook:', err);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server đang chạy tại cổng ${PORT}`);
});
