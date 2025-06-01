import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const event = req.body;

  if (event?.header?.event_type === 'im.message.receive_v1') {
    const messageId = event.event.message.message_id;
    const userMessage = event.event.message.content;

    console.log('🔔 Received message:', userMessage);

    try {
      const completion = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: userMessage }
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const reply = completion.data.choices[0].message.content;
      console.log('💬 Replying with:', reply);

      // TODO: Gửi trả lời về Lark ở đây nếu cần

    } catch (error) {
      console.error('❌ Error from OpenAI:', error?.response?.data || error.message);
    }
  } else {
    console.log('⛔ Không phải message event hoặc thiếu header:', event);
  }

  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.send('Bot is running');
});

app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});
