require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { Client, createLogger } = require('@larksuiteoapi/node-sdk');
const OpenAI = require('openai');

const app = express();
app.use(bodyParser.json());

const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self',
  domain: 'https://open.larksuite.com',
  encryptKey: process.env.LARK_ENCRYPT_KEY,
  verificationToken: process.env.LARK_VERIFICATION_TOKEN,
  logger: createLogger({ level: 'info' }), // ✅ sửa ở đây
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post('/webhook', async (req, res) => {
  const verificationToken = process.env.LARK_VERIFICATION_TOKEN;

  if (
    req.body.token !== verificationToken &&
    req.headers['x-verification-token'] !== verificationToken
  ) {
    console.log('[❌] Invalid verify token:', req.body.token);
    return res.status(401).send('Unauthorized');
  }

  if (req.body.type === 'url_verification') {
    return res.send({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  if (event && event.message && event.message.message_type === 'text') {
    const text = JSON.parse(event.message.content).text;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: text }],
      });

      const reply = completion.choices[0].message.content;

      await client.im.message.reply({
        path: {
          message_id: event.message.message_id,
        },
        data: {
          content: JSON.stringify({ text: reply }),
          msg_type: 'text',
        },
      });
    } catch (err) {
      console.error('OpenAI error:', err.message);
    }
  }

  res.status(200).send('OK');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[✅] Server running on port ${PORT}`);
});
