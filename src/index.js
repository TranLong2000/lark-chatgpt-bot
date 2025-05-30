// src/index.js

const express = require('express');
const crypto = require('crypto');
const dotenv = require('dotenv');
const fetch = require('node-fetch'); // nếu chưa cài: npm install node-fetch@2
const { Configuration, OpenAIApi } = require('openai');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Hàm giải mã dữ liệu webhook Lark
function decryptLarkData(encryptData) {
  const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);

  let decrypted = decipher.update(encryptData, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  // Loại bỏ padding manually
  const paddingLength = decrypted.charCodeAt(decrypted.length - 1);
  return decrypted.slice(0, decrypted.length - paddingLength);
}

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

app.post('/webhook', async (req, res) => {
  try {
    if (!req.body || !req.body.encrypt) {
      console.warn('Không có payload encrypt');
      return res.status(400).send('Missing encrypt data');
    }

    const decryptedStr = decryptLarkData(req.body.encrypt);
    const payload = JSON.parse(decryptedStr);

    if (!payload || !payload.event) {
      console.warn('event hoặc event.message không tồn tại');
      return res.status(400).send('Missing event data');
    }

    const event = payload.event;

    // Ví dụ xử lý sự kiện message nhận được
    if (event.type === 'im.message.receive_v1') {
      const userId = event.sender.senderId;
      const messageText = event.message.message;

      // Gọi OpenAI
      const completion = await openai.createChatCompletion({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: messageText }],
      });

      const replyText = completion.data.choices[0].message.content;

      // Gửi trả lại message qua API Lark
      const sendMessageRes = await fetch('https://open.larksuite.com/open-apis/im/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.LARK_APP_ACCESS_TOKEN}`, // bạn cần có access token, phải lấy trước hoặc triển khai OAuth
        },
        body: JSON.stringify({
          receive_id: userId,
          msg_type: 'text',
          content: JSON.stringify({ text: replyText }),
        }),
      });

      const sendMessageData = await sendMessageRes.json();

      if (!sendMessageData || sendMessageData.code !== 0) {
        console.error('Lỗi gửi tin nhắn:', sendMessageData);
      }
    }

    res.status(200).send('ok');
  } catch (error) {
    console.error('❌ Lỗi xử lý webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
