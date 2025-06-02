const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const chatHistories = {}; // Lưu hội thoại theo user

app.use(bodyParser.json());

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
    const messageText = decrypted.event.message.content;
    const messageId = decrypted.event.message.message_id;
    const userId = decrypted.event.sender.sender_id.user_id;

    try {
      const parsedContent = JSON.parse(messageText);
      const userMessage = parsedContent.text;

      // Lấy thời gian hiện tại (giờ Việt Nam)
      const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

      // Khởi tạo hội thoại nếu chưa có
      if (!chatHistories[userId]) {
        chatHistories[userId] = [
          {
            role: 'system',
            content: `Bạn là một trợ lý AI. Hôm nay là ${now}. Trả lời chính xác và ngắn gọn.`,
          },
        ];
      }

      // Thêm câu hỏi mới
      chatHistories[userId].push({ role: 'user', content: userMessage });

      // Giữ lại tối đa 10 tin nhắn gần nhất
      if (chatHistories[userId].length > 10) {
        chatHistories[userId] = chatHistories[userId].slice(-10);
      }

      // Gọi API OpenRouter (giới hạn token)
      const chatResponse = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'openai/gpt-4o',
          messages: chatHistories[userId],
          max_tokens: 1000 // ✅ Hạn chế token trả về
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://yourdomain.com/',
            'X-Title': 'My Lark Bot',
          },
        }
      );

      const reply = chatResponse.data.choices[0].message.content;

      // Lưu phản hồi vào lịch sử
      chatHistories[userId].push({ role: 'assistant', content: reply });

      await replyToLark(messageId, reply);
    } catch (error) {
      console.error('[OpenRouter Error]', error.message);
      if (error.response) {
        console.error('Response data:', error.response.data);
      }
      await replyToLark(messageId, 'Xin lỗi, có lỗi xảy ra. Bạn thử lại sau nhé.');
    }
  }

  res.send({ code: 0 });
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
