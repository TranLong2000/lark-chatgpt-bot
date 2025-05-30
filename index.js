import express from 'express';
import dotenv from 'dotenv';
import { Client, createLogger, logLevel } from '@larksuiteoapi/node-sdk';
import { Configuration, OpenAIApi } from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

// Khởi tạo Lark SDK
const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  domain: 'https://open.larksuite.com',
  logger: createLogger({ level: logLevel.INFO }),
});

// Khởi tạo OpenAI SDK
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// Webhook
app.post('/webhook', async (req, res) => {
  const verifyToken = req.headers['x-lark-verify-token'];
  const expectedToken = process.env.LARK_VERIFICATION_TOKEN;

  console.log('[DEBUG] Header token:', verifyToken);
  console.log('[DEBUG] Expected token:', expectedToken);

  if (verifyToken !== expectedToken) {
    console.error('[❌] Invalid verify token:', verifyToken);
    return res.status(401).send('Invalid verify token');
  }

  const event = req.body;

  // Xử lý sự kiện nhận tin nhắn
  if (event.header && event.header.event_type === 'im.message.receive_v1') {
    const messageContent = JSON.parse(event.event.message.content);
    const userMessage = messageContent.text;
    const userId = event.event.sender.sender_id.user_id;

    console.log(`[📩] Tin nhắn từ ${userId}: ${userMessage}`);

    // Gọi OpenAI để trả lời
    try {
      const completion = await openai.createChatCompletion({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: userMessage }],
      });

      const reply = completion.data.choices[0].message.content;

      // Gửi lại tin nhắn cho người dùng
      await client.im.message.create({
        receive_id_type: 'user_id',
        body: {
          receive_id: userId,
          msg_type: 'text',
          content: JSON.stringify({ text: reply }),
        },
      });

      console.log('[✅] Đã trả lời người dùng.');
      return res.status(200).send('OK');
    } catch (err) {
      console.error('[❌] Lỗi khi gọi OpenAI hoặc gửi tin nhắn:', err);
      return res.status(500).send('Error processing message');
    }
  }

  res.status(200).send('No action');
});

// Khởi động server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[🚀] Server đang chạy tại http://localhost:${PORT}`);
});
