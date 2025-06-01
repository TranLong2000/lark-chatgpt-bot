import express from 'express';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import axios from 'axios';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Verify Lark request signature
function verifyLarkRequest(req) {
  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  const signature = req.headers['x-lark-signature'];
  const body = JSON.stringify(req.body);

  const stringToSign = `${timestamp}\n${nonce}\n${body}`;
  const hmac = crypto.createHmac('sha256', process.env.LARK_ENCRYPT_KEY);
  hmac.update(stringToSign);
  const mySignature = hmac.digest('base64');

  return mySignature === signature;
}

app.post('/webhook', async (req, res) => {
  const event = req.body;

  // URL verification
  if (event.type === 'url_verification') {
    return res.send({ challenge: event.challenge });
  }

  // Security check
  if (!verifyLarkRequest(req)) {
    console.log('Invalid Lark signature');
    return res.status(401).send('Unauthorized');
  }

  // Only handle message receive event
  if (event.header.event_type === 'im.message.receive_v1') {
    const messageText = event.event.message.content;
    const messageId = event.event.message.message_id;
    const senderId = event.event.sender.sender_id.user_id;

    let userMessage;
    try {
      const content = JSON.parse(messageText);
      userMessage = content.text;
    } catch (err) {
      return res.status(200).send();
    }

    try {
      // Call OpenAI ChatGPT API
      const openaiResponse = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: userMessage }]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const reply = openaiResponse.data.choices[0].message.content;

      // Reply via Lark message API
      await axios.post(
        'https://open.larkoffice.com/open-apis/im/v1/messages',
        {
          receive_id: senderId,
          content: JSON.stringify({ text: reply }),
          msg_type: 'text'
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.LARK_BOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
            'X-Request-ID': messageId
          },
          params: {
            receive_id_type: 'user_id'
          }
        }
      );
    } catch (err) {
      console.error('Error calling OpenAI or sending Lark reply:', err.message);
    }
  }

  res.status(200).send();
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
