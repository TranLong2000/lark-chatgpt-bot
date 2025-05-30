const express = require('express');
const crypto = require('crypto');
const { Client } = require('@larksuiteoapi/node-sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// Hàm giải mã dữ liệu từ Lark
function decryptLarkData(encrypt) {
  const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'utf8');
  const encryptedData = Buffer.from(encrypt, 'base64');

  const iv = encryptedData.subarray(0, 16);
  const ciphertext = encryptedData.subarray(16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(true);

  let decrypted = decipher.update(ciphertext, null, 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}

const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: 'self',
  domain: process.env.LARK_DOMAIN || 'https://open.larksuite.com',
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('=== Webhook payload ===');
    console.log(JSON.stringify(req.body, null, 2));

    let data = req.body;

    // Nếu payload bị mã hóa
    if (data.encrypt) {
      data = decryptLarkData(data.encrypt);
      console.log('✅ Payload đã giải mã:', JSON.stringify(data, null, 2));
    }

    const event = data.event;
    if (!event || !event.message) {
      console.warn('⚠️ event hoặc event.message không tồn tại');
      return res.sendStatus(200);
    }

    const message = event.message;
    const userMessage = JSON.parse(message.content).text || '';

    const openaiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: userMessage }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const aiReply = openaiRes.data.choices[0].message.content;

    await client.im.message.reply({
      path: {
        message_id: message.message_id,
      },
      data: {
        content: JSON.stringify({ text: aiReply }),
        msg_type: 'text',
      },
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Lỗi xử lý webhook:', error);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});
