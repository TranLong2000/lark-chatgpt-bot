const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

console.log('OPENROUTER_API_KEY:', process.env.OPENROUTER_API_KEY ? 'FOUND' : 'NOT FOUND');
console.log('OPENROUTER_API_KEY value:', process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.substring(0, 8) + '...' : 'undefined');

app.use(bodyParser.json());

const chatHistories = {};
const errorSentMessages = new Set();

function verifySignature(timestamp, nonce, body, signature) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  const raw = `${timestamp}${nonce}${encryptKey}${body}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return hash === signature;
}

function decryptMessage(encrypt) {
  const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'utf-8');
  const aesKey = crypto.createHash('sha256').update(key).digest();
  const data = Buffer.from(encrypt, 'base64');
  const iv = data.slice(0, 16);
  const encryptedText = data.slice(16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return JSON.parse(decrypted.toString());
}

async function replyToLark(messageId, content) {
  try {
    const tokenResp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`, {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    });

    const token = tokenResp.data.app_access_token;

    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages/${messageId}/reply`,
      {
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('[Reply Error]', err?.response?.data || err.message);
  }
}

app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-lark-signature'];
  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  const body = JSON.stringify(req.body);

  console.log('\n--- New Webhook Request ---');
  console.log('Headers:', req.headers);
  console.log('Body:', body);

  if (!verifySignature(timestamp, nonce, body, signature)) {
    console.warn('[Webhook] Invalid signature – stop.');
    return res.status(401).send('Invalid signature');
  }

  const { encrypt } = req.body;
  const decrypted = decryptMessage(encrypt);

  if (decrypted.header.event_type === 'url_verification') {
    return res.send({ challenge: decrypted.event.challenge });
  }

  if (decrypted.header.event_type === 'im.message.receive_v1') {
    const senderId = decrypted.event.sender.sender_id;
    const userId = decrypted.event.sender.user_id;
    const mentions = decrypted.event.message.mentions || [];
    const messageId = decrypted.event.message.message_id;
    const messageText = decrypted.event.message.content;

    console.log('Sender ID:', senderId);
    console.log('User ID:', userId);

    // Gợi ý: dùng các dòng log này để copy vào .env
    console.log('👉 Copy vào .env:');
    console.log(`BOT_SENDER_ID=${senderId}`);
    console.log(`BOT_USER_ID=${userId}`);

    const BOT_SENDER_ID = process.env.BOT_SENDER_ID;
    const BOT_USER_ID = process.env.BOT_USER_ID;

    // Tránh bot trả lời chính nó hoặc khi bị tag @all mà không phải cá nhân bot
    const isMentionAll = mentions.some(m => m.id && m.id.open_id === 'all');
    const isMentionBot = mentions.some(m => m.id && m.id.open_id === BOT_USER_ID);

    if (senderId === BOT_SENDER_ID || (isMentionAll && !isMentionBot)) {
      console.log('➡️ Tin nhắn từ bot hoặc tag @all không dành cho bot, bỏ qua.');
      return res.send({ code: 0 });
    }

    try {
      const parsedContent = JSON.parse(messageText);
      const userMessage = parsedContent.text;

      if (!chatHistories[userId]) {
        chatHistories[userId] = [];
      }

      chatHistories[userId].push({ role: 'user', content: userMessage });

      if (chatHistories[userId].length > 20) {
        chatHistories[userId].splice(0, chatHistories[userId].length - 20);
      }

      const chatResponse = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'openai/gpt-4',
          messages: [
            {
              role: 'system',
              content: 'Bạn là một trợ lý thông minh, luôn trả lời ngắn gọn, chính xác, cập nhật thông tin ngày giờ nếu được hỏi.',
            },
            ...chatHistories[userId],
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const reply = chatResponse.data.choices[0].message.content;

      chatHistories[userId].push({ role: 'assistant', content: reply });
      await replyToLark(messageId, reply);

      errorSentMessages.delete(messageId);
    } catch (error) {
      console.error('[OpenRouter Error]', error.message);
      if (error.response) {
        console.error('Response data:', error.response.data);
        console.error('Response status:', error.response.status);
      }

      if (!errorSentMessages.has(messageId)) {
        await replyToLark(messageId, 'Xin lỗi, có lỗi xảy ra khi xử lý tin nhắn của bạn.');
        errorSentMessages.add(messageId);
      } else {
        console.log(`[Info] Đã gửi lỗi cho messageId ${messageId} trước đó, không gửi lại.`);
      }
    }
  }

  res.send({ code: 0 });
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
