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

// Bộ nhớ lưu lịch sử chat, key là user_id, value là mảng message
const chatHistories = {};

// Set lưu messageId đã gửi lỗi, tránh reply lỗi nhiều lần cho cùng 1 message
const errorSentMessages = new Set();

// Set lưu messageId đã xử lý thành công, tránh xử lý lại trùng lặp
const processedMessageIds = new Set();

// Hàm để giới hạn kích thước Set hoặc Object tránh tăng bộ nhớ vô tận
function limitSize(setOrObj, maxSize) {
  if (setOrObj instanceof Set) {
    while (setOrObj.size > maxSize) {
      // Xóa phần tử đầu tiên
      const first = setOrObj.values().next().value;
      setOrObj.delete(first);
    }
  } else if (typeof setOrObj === 'object') {
    const keys = Object.keys(setOrObj);
    while (keys.length > maxSize) {
      delete setOrObj[keys[0]];
      keys.shift();
    }
  }
}

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
    const messageId = decrypted.event.message.message_id;

    // Tránh bot trả lời chính nó
    const BOT_SENDER_ID = process.env.BOT_SENDER_ID || 'YOUR_BOT_SENDER_ID';
    if (senderId === BOT_SENDER_ID) {
      console.log('Tin nhắn từ bot, bỏ qua để tránh vòng lặp.');
      return res.send({ code: 0 });
    }

    // Nếu đã xử lý message này rồi thì bỏ qua luôn
    if (processedMessageIds.has(messageId)) {
      console.log(`[Info] Đã xử lý messageId ${messageId} trước đó, bỏ qua.`);
      return res.send({ code: 0 });
    }

    const messageText = decrypted.event.message.content;

    try {
      const parsedContent = JSON.parse(messageText);
      const userMessage = parsedContent.text;

      if (!chatHistories[userId]) {
        chatHistories[userId] = [];
      }

      // Thêm tin nhắn người dùng
      chatHistories[userId].push({ role: 'user', content: userMessage });

      // Giới hạn lịch sử chat tối đa 20 câu để tránh quá dài
      if (chatHistories[userId].length > 20) {
        chatHistories[userId].splice(0, chatHistories[userId].length - 20);
      }

      // Thêm hệ thống prompt để BOT hiểu bối cảnh thời gian, lịch sử
      const systemPrompt = {
        role: 'system',
        content:
          'Bạn là trợ lý AI thông minh, trả lời câu hỏi một cách thân thiện và chính xác. ' +
          `Hiện tại là ngày ${new Date().toLocaleDateString('vi-VN')}, giờ ${new Date().toLocaleTimeString('vi-VN')}.`,
      };

      const messagesToSend = [systemPrompt, ...chatHistories[userId]];

      // Gọi OpenRouter API chat completion
      const chatResponse = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'openai/gpt-3.5-turbo',
          messages: messagesToSend,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const reply = chatResponse.data.choices[0].message.content;

      // Thêm câu trả lời bot vào lịch sử chat
      chatHistories[userId].push({ role: 'assistant', content: reply });

      await replyToLark(messageId, reply);

      // Đánh dấu message đã xử lý thành công
      processedMessageIds.add(messageId);

      // Nếu trước đó đã gửi lỗi với message này, giờ bỏ qua (đã thành công)
      if (errorSentMessages.has(messageId)) {
        errorSentMessages.delete(messageId);
      }

      // Giới hạn kích thước bộ nhớ tránh tràn
      limitSize(processedMessageIds, 1000);
      limitSize(chatHistories, 1000);
      limitSize(errorSentMessages, 1000);

    } catch (error) {
      console.error('[OpenRouter Error]', error.message);
      if (error.response) {
        console.error('Response data:', error.response.data);
        console.error('Response status:', error.response.status);
        console.error('Response headers:', error.response.headers);
      }

      // Chỉ reply lỗi 1 lần cho mỗi messageId
      if (!errorSentMessages.has(messageId)) {
        await replyToLark(messageId, 'Xin lỗi, có lỗi xảy ra khi xử lý tin nhắn của bạn.');
        errorSentMessages.add(messageId);
      } else {
        console.log(`[Info] Đã gửi lỗi cho messageId ${messageId} trước đó, không gửi lại.`);
      }

      // Trả về thành công để tránh Lark retry liên tục
      return res.send({ code: 0 });
    }
  }

  res.send({ code: 0 });
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
