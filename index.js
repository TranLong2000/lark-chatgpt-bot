require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Configuration, OpenAIApi } = require('openai');

const app = express();
app.use(express.json());

// Setup OpenAI
const openai = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
  })
);

// Hàm giải mã dữ liệu từ Lark
function decryptData(encryptKey, encrypt) {
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(encryptKey, 'utf8'),
    Buffer.from(encrypt.iv, 'base64')
  );
  let decrypted = decipher.update(encrypt.encrypt, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// Xử lý sự kiện webhook
app.post('/webhook', async (req, res) => {
  const verifyToken = req.headers['x-lark-verify-token'];

  if (verifyToken !== process.env.LARK_VERIFICATION_TOKEN) {
    console.log('[❌] Invalid verify token:', verifyToken);
    return res.status(401).send('Unauthorized');
  }

  const body = req.body;

  // Trả lời ping từ Lark
  if (body.type === 'url_verification') {
    return res.send({ challenge: body.challenge });
  }

  // Giải mã nếu có
  let eventData = body;
  if (body.encrypt) {
    try {
      eventData = decryptData(process.env.LARK_ENCRYPT_KEY, body);
    } catch (e) {
      console.error('[❌] Failed to decrypt:', e.message);
      return res.status(400).send('Bad request');
    }
  }

  const event = eventData.event;
  const messageText = event?.message?.content;
  const senderId = event?.sender?.sender_id?.user_id;

  if (!messageText || !senderId) {
    return res.status(200).send('No message');
  }

  try {
    // Gọi OpenAI
    const completion = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'user', content: JSON.parse(messageText).text },
      ],
    });

    const reply = completion.data.choices[0].message.content;

    // Gửi tin nhắn phản hồi
    await fetch('https://open.larksuite.com/open-apis/im/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LARK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        receive_id: senderId,
        content: JSON.stringify({ text: reply }),
        msg_type: 'text',
        receive_id_type: 'user_id',
      }),
    });

    return res.status(200).send('OK');
  } catch (err) {
    console.error('[❌] Error replying:', err);
    return res.status(500).send('Error');
  }
});

// Khởi động server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[✅] Server is running on port ${PORT}`);
});
