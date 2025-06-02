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

// Bộ nhớ lưu lịch sử chat
const chatHistories = {};

// Lưu messageId đã trả lời lỗi để tránh lặp lại
const errorSentMessages = new Set();

// Lưu messageId đã trả lời thành công để tránh BOT trả lời 2 lần cho cùng message
const answeredMessageIds = new Set();

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
    const appAccessTokenResp = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`,
      {
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }
    );
    const token = appAccessTokenResp.data.app_access_token;

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
    const senderType = decrypted.event.sender.sender_type; // Đây mới là thứ quan trọng để biết tin nhắn từ bot hay user
    const messageId = decrypted.event.message.message_id;

    console.log('👤 senderId:', senderId);
    console.log('👤 senderType:', senderType);
    console.log('📨 messageId:', messageId);

    // Nếu tin nhắn do chính bot gửi thì bỏ qua luôn
    if (senderType === 'app') {
      console.log('➡️ Bỏ qua message do chính bot gửi');
      return res.send({ code: 0 });
    }

    // Nếu đã trả lời rồi thì bỏ qua để tránh trả lời nhiều lần
    if (answeredMessageIds.has(messageId)) {
      console.log(`⚠️ Đã trả lời messageId ${messageId} trước đó, bỏ qua.`);
      return res.send({ code: 0 });
    }

    const userId = senderId.user_id;

    const messageText = decrypted.event.message.content;
    let userMessage = '';

    try {
      const parsedContent = JSON.parse(messageText);
      userMessage = parsedContent.text || '';
    } catch (e) {
      console.warn('[Parse Error] Không thể parse messageText:', messageText);
      return res.send({ code: 0 });
    }

    // Bỏ qua nếu tag @all hoặc @everyone
    if (
      userMessage.includes('<at user_id="all">') ||
      userMessage.toLowerCase().includes('@all') ||
      userMessage.toLowerCase().includes('@everyone')
    ) {
      console.log('Tin nhắn có tag @all hoặc @everyone, bỏ qua.');
      return res.send({ code: 0 });
    }

    try {
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
          model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
          messages: [
            {
              role: 'system',
              content: 'Bạn là một trợ lý AI thông minh, luôn trả lời chính xác, ngắn gọn và cập nhật thời gian hiện tại nếu được hỏi.',
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

      // Đánh dấu đã trả lời message này
      answeredMessageIds.add(messageId);
      if (answeredMessageIds.size > 1000) {
        const firstKey = answeredMessageIds.values().next().value;
        answeredMessageIds.delete(firstKey);
      }

      // Nếu trước đó có lỗi thì xoá khỏi danh sách
      if (errorSentMessages.has(messageId)) {
        errorSentMessages.delete(messageId);
      }

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
        console.log(`[Info] Đã gửi lỗi cho messageId ${messageId}, không gửi lại.`);
      }
    }
  }

  res.send({ code: 0 });
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
