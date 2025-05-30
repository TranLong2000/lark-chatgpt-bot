const express = require('express');
const { Client, createLogger, LogLevel } = require('@larksuiteoapi/node-sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self',
  domain: process.env.LARK_DOMAIN || 'https://open.larksuite.com',
  logger: createLogger({ level: LogLevel.INFO }),
});

// Middleware xử lý webhook
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;

    console.log('=== Webhook payload ===');
    console.log(JSON.stringify(payload, null, 2));

    const event = payload?.event;

    if (!event || !event.message) {
      console.warn('⚠️ event hoặc event.message không tồn tại');
      return res.sendStatus(200);
    }

    const messageText = event.message.content;
    const openId = event.sender.sender_id.open_id;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Bạn là trợ lý ảo thông minh.' },
          { role: 'user', content: messageText },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const reply = response.data.choices?.[0]?.message?.content || 'Không có phản hồi từ ChatGPT.';

    await client.im.message.create({
      data: {
        receive_id: openId,
        content: JSON.stringify({ text: reply }),
        msg_type: 'text',
        receive_id_type: 'open_id',
      },
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Lỗi xử lý webhook:', error);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
