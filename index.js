// index.js
import express from 'express';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import { Configuration, OpenAIApi } from 'openai';

const app = express();
const PORT = process.env.PORT || 8080;

// Dùng bodyParser middleware để parse JSON
app.use(bodyParser.json());

// Xác thực webhook request từ Lark bằng Verification Token
function verifyRequest(req) {
  const token = process.env.LARK_VERIFICATION_TOKEN;
  const signature = req.headers['x-lark-signature'];

  if (!token || !signature) return false;

  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  if (!timestamp || !nonce) return false;

  const stringToSign = timestamp + nonce + JSON.stringify(req.body);
  const hash = crypto.createHmac('sha256', token).update(stringToSign).digest('hex');

  return signature === hash;
}

// Khởi tạo OpenAI client
const openai = new OpenAIApi(new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
}));

// Webhook route
app.post('/webhook', async (req, res) => {
  if (!verifyRequest(req)) {
    return res.status(401).send('Invalid signature');
  }

  const event = req.body;

  // Log để kiểm tra dữ liệu nhận được
  console.log('Received event:', JSON.stringify(event, null, 2));

  // Xử lý sự kiện tin nhắn
  if (event.type === 'im.message.receive_v1') {
    try {
      const message = event.event.message;
      const userText = message.text;

      // Gọi OpenAI API để lấy phản hồi
      const completion = await openai.createChatCompletion({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: userText },
        ],
      });

      const replyText = completion.data.choices[0].message.content;

      // Gửi trả lời lại cho người dùng qua API Lark (bạn cần token truy cập bot)
      // --- Phần gửi trả lời bạn tự tích hợp API Lark, ví dụ call API gửi message ---

      console.log('Reply to user:', replyText);
    } catch (err) {
      console.error('OpenAI API error:', err);
    }
  }

  res.status(200).send('ok');
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
