const express = require('express');
const { Client, EventDispatcher } = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json());

const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com',
});

const dispatcher = new EventDispatcher({ client });

dispatcher.register({
  type: 'message.receive_v1',
  handler: async (data) => {
    const message = data.event.message;
    console.log('Tin nhắn nhận được:', message);

    return {
      msg_type: 'text',
      content: {
        text: `Bạn vừa gửi: ${message.text || '...'}`,
      },
    };
  },
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('Received webhook:', JSON.stringify(req.body));

    if (req.body.challenge) {
      return res.json({ challenge: req.body.challenge });
    }

    await dispatcher.dispatch(req, res);
  } catch (err) {
    console.error('Error dispatching event:', err);
    if (err instanceof Error) {
      console.error(err.stack);
    } else {
      console.error(JSON.stringify(err));
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/', (req, res) => {
  res.send('Bot Lark đang chạy OK!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot Lark đang chạy tại http://localhost:${PORT}`);
});
