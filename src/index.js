const express = require('express');
const { Client, EventDispatcher } = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self',
  verificationToken: process.env.LARK_VERIFICATION_TOKEN,
  encryptKey: process.env.LARK_ENCRYPT_KEY,
});

const dispatcher = new EventDispatcher({ client });

dispatcher.registerMessageEvent(async (data) => {
  const messageText = data.event.message.content;
  const userId = data.event.sender.sender_id.user_id;

  const prompt = JSON.parse(messageText).text;

  // Gọi OpenAI GPT
  const openaiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: prompt }],
  }, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const reply = openaiRes.data.choices[0].message.content;

  // Gửi trả lời về lại Lark
  await client.im.message.create({
    data: {
      receive_id: userId,
      content: JSON.stringify({ text: reply }),
      msg_type: 'text',
    },
    params: {
      receive_id_type: 'user_id',
    },
  });
});

app.use(express.json());
app.post('/webhook', dispatcher.handleEvent());

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
