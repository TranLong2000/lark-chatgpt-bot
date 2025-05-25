import express from 'express';
import dotenv from 'dotenv';
import { Configuration, OpenAIApi } from 'openai';
import Lark from '@larksuiteoapi/node-sdk';

dotenv.config();

const app = express();
app.use(express.json());

const { LARK_APP_ID, LARK_APP_SECRET, OPENAI_API_KEY } = process.env;

// Khởi tạo OpenAI client
const openai = new OpenAIApi(new Configuration({
  apiKey: OPENAI_API_KEY,
}));

// Khởi tạo Lark SDK
const client = Lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
});

app.post('/', async (req, res) => {
  try {
    const { header, schema, event } = req.body;

    // Xác thực verify_token lần đầu
    if (header.event_type === 'url_verification') {
      return res.json({ challenge: schema.challenge });
    }

    // Chỉ xử lý message.receive_v1
    if (header.event_type !== 'im.message.receive_v1') {
      return res.status(200).end();
    }

    const messageId = event.message.message_id;
    const openId = event.open_id;

    // Lấy content
    const messageResp = await client.im.message.get({
      path: { message_id: messageId },
    });
    const userText = messageResp.data.message.content.text;

    // Gọi ChatGPT
    const aiRes = await openai.createChatCompletion({
      model: 'gpt-4',
      messages: [{ role: 'user', content: userText }],
    });
    const botReply = aiRes.data.choices[0].message.content;

    // Gửi reply về Lark
    await client.im.message.reply({
      path: { receive_id: messageId },
      data: {
        msg_type: 'text',
        content: { text: botReply },
      },
    });

    res.status(200).end();
  } catch (err) {
    console.error('Error handling webhook:', err);
    res.status(500).send('Internal Server Error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Bot listening on port ${port}`);
});
