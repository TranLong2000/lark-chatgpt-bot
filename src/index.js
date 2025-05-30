const express = require('express');
const { Client, EventDispatcher } = require('@larksuiteoapi/node-sdk');
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
});

const dispatcher = new EventDispatcher({ client });

dispatcher.registerHandler('im.message.receive_v1', async (data) => {
  const event = data?.event;

  console.log('>>> Event nhận được:', JSON.stringify(event, null, 2));

  if (!event || !event.message) {
    console.warn('⚠️ event hoặc event.message không tồn tại');
    return;
  }

  const messageText = event.message.content;
  const openId = event.sender.sender_id.open_id;

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'Bạn là một trợ lý ảo thông minh.' },
        { role: 'user', content: messageText }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const reply = response.data.choices?.[0]?.message?.content || 'Không có phản hồi từ ChatGPT.';

    await client.im.message.create({
      data: {
        receive_id: openId,
        content: JSON.stringify({ text: reply }),
        msg_type: 'text',
        receive_id_type: 'open_id'
      }
    });

  } catch (error) {
    console.error('❌ Lỗi khi gọi OpenAI hoặc gửi tin nhắn:', error.message);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const result = await dispatcher.dispatch(req.body);
    res.status(200).send(result);
  } catch (err) {
    console.error('❌ Lỗi xử lý webhook:', err);
    res.status(500).send('Webhook xử lý lỗi');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
