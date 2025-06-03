const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

const chatHistories = new Map();
const processedMessageIds = new Set();

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
    const tokenResp = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`,
      {
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }
    );
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

  if (!verifySignature(timestamp, nonce, body, signature)) {
    console.warn('[Webhook] Invalid signature');
    return res.status(401).send('Invalid signature');
  }

  const { encrypt } = req.body;
  const decrypted = decryptMessage(encrypt);

  if (decrypted.header.event_type === 'url_verification') {
    return res.send({ challenge: decrypted.event.challenge });
  }

  if (decrypted.header.event_type === 'im.message.receive_v1') {
    const senderId = decrypted.event.sender.sender_id;
    const messageId = decrypted.event.message.message_id;
    const chatId = decrypted.event.message.chat_id;
    const chatType = decrypted.event.message.chat_type; // 'p2p' hoặc 'group'
    const chatKey = chatType === 'p2p' ? `user_${senderId}` : `group_${chatId}`;

    if (processedMessageIds.has(messageId)) {
      console.log(`[Info] Message ${messageId} đã xử lý rồi, bỏ qua.`);
      return res.send({ code: 0 });
    }

    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 10000) {
      const firstKey = processedMessageIds.values().next().value;
      processedMessageIds.delete(firstKey);
    }

    const BOT_SENDER_ID = process.env.BOT_SENDER_ID || '';
    if (senderId === BOT_SENDER_ID) {
      console.log('[Info] Tin nhắn của BOT, bỏ qua');
      return res.send({ code: 0 });
    }

    let userMessage = '';
    try {
      const parsedContent = JSON.parse(decrypted.event.message.content);
      userMessage = parsedContent.text || '';
    } catch (e) {
      console.warn('[Parse Error] Không thể parse message');
      return res.send({ code: 0 });
    }

    // Bỏ qua nếu là tag @all trong nhóm
    const mentions = decrypted.event.message.mentions || [];
    const hasAtAll = mentions.some(m => m.id?.user_id === 'all');
    if (chatType === 'group' && (hasAtAll || userMessage.toLowerCase().includes('@all') || userMessage.toLowerCase().includes('@everyone'))) {
      console.log('[Info] Tin nhắn trong nhóm có tag @all hoặc @everyone, bỏ qua');
      return res.send({ code: 0 });
    }

    try {
      // Xoá nếu quá 2 tiếng
      const cache = chatHistories.get(chatKey);
      if (cache && Date.now() - cache.lastUpdated > 2 * 60 * 60 * 1000) {
        chatHistories.delete(chatKey);
      }

      // Tạo mới nếu chưa có
      if (!chatHistories.has(chatKey)) {
        chatHistories.set(chatKey, { messages: [], lastUpdated: Date.now() });
      }

      const current = chatHistories.get(chatKey);
      current.messages.push({ role: 'user', content: userMessage });

      if (current.messages.length > 20) {
        current.messages.splice(0, current.messages.length - 20);
      }

      current.lastUpdated = Date.now();

      const chatResponse = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
          messages: [
            {
              role: 'system',
              content: 'Bạn là một trợ lý AI thông minh, luôn trả lời chính xác, ngắn gọn và cập nhật thời gian hiện tại nếu được hỏi.',
            },
            ...current.messages,
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
      current.messages.push({ role: 'assistant', content: reply });
      current.lastUpdated = Date.now();

      await replyToLark(messageId, reply);
    } catch (error) {
      console.error('[OpenRouter Error]', error.message);
      if (error.response) {
        console.error('Response data:', error.response.data);
        console.error('Response status:', error.response.status);
      }

      await replyToLark(messageId, 'Xin lỗi, có lỗi xảy ra khi xử lý tin nhắn của bạn.');
    }
  }

  res.send({ code: 0 });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
