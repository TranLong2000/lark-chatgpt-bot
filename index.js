const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// ─── 1. Middleware: Đọc raw body để sau này dùng decrypt ───────────────────────────────
app.use(
  '/webhook',
  express.raw({
    type: '*/*',
    limit: '1mb', // tùy nhu cầu, giới hạn size payload
  })
);

// ─── 2. Cấu hình lưu cache token Lark ────────────────────────────────────────────────
let cachedAppAccessToken = null;
let tokenExpiresAt = 0; // timestamp (ms) khi token hết hạn

async function getAppAccessToken() {
  const now = Date.now();
  if (cachedAppAccessToken && now < tokenExpiresAt - 10000) {
    // còn token, chưa đến lúc hết hạn (trả về luôn, trừ trừ 10 s “phòng hờ”)
    return cachedAppAccessToken;
  }

  try {
    const resp = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`,
      {
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000, // timeout 5s nếu quá lâu
      }
    );
    const data = resp.data;
    const token = data.app_access_token;
    // Lark trả về token và valid_duration (thường ~7200s)
    const validSec = data.expire || data.expire_in || 7200; 
    cachedAppAccessToken = token;
    tokenExpiresAt = now + validSec * 1000;
    return token;
  } catch (err) {
    console.error('[getAppAccessToken Error]', err?.response?.data || err.message);
    throw err;
  }
}

// ─── 3. Hàm decrypt message Lark ─────────────────────────────────────────────────────
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

// ─── 4. Hàm xác minh signature ───────────────────────────────────────────────────────
function verifySignature(timestamp, nonce, bodyBuffer, signature) {
  const bodyString = bodyBuffer.toString('utf-8');
  const raw = `${timestamp}${nonce}${process.env.LARK_ENCRYPT_KEY}${bodyString}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return hash === signature;
}

// ─── 5. Hàm reply trả lời ─────────────────────────────────────────────────────────────
async function replyToLark(messageId, content) {
  try {
    const token = await getAppAccessToken();
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
        timeout: 5000,
      }
    );
  } catch (err) {
    console.error('[Reply Error]', err?.response?.data || err.message);
  }
}

// ─── 6. Biến lưu cache trong runtime ────────────────────────────────────────────────
// Lưu lịch sử chat mỗi user
const chatHistories = {};
// Tránh trả lời lặp: store messageId đã trả lời thành công
const answeredMessageIds = new Set();
// Tránh spam lỗi: lưu messageId từng gửi báo lỗi
const errorSentMessages = new Set();

app.post('/webhook', async (req, res) => {
  // ─ verify signature ────────────────────────────────────────────────────
  const signature = req.headers['x-lark-signature'];
  const timestamp = req.headers['x-lark-request-timestamp'];
  const nonce = req.headers['x-lark-request-nonce'];
  const bodyBuffer = req.body; // Buffer vì xài express.raw()

  if (!verifySignature(timestamp, nonce, bodyBuffer, signature)) {
    console.warn('[Webhook] Invalid signature – stopped.');
    return res.status(401).send('Invalid signature');
  }

  // ─ decrypt payload ─────────────────────────────────────────────────────
  let decrypted;
  try {
    const bodyJson = JSON.parse(bodyBuffer.toString('utf-8'));
    decrypted = decryptMessage(bodyJson.encrypt);
  } catch (err) {
    console.warn('[Decrypt Error]', err.message);
    return res.send({ code: 0 });
  }

  // ─ url_verification ─────────────────────────────────────────────────────
  if (decrypted.header.event_type === 'url_verification') {
    return res.send({ challenge: decrypted.event.challenge });
  }

  // ─ xử lý im.message.receive_v1 ──────────────────────────────────────────
  if (decrypted.header.event_type === 'im.message.receive_v1') {
    const senderType = decrypted.event.sender.sender_type; // 'user' hoặc 'app'
    const messageId = decrypted.event.message.message_id;

    // Nếu là bot gửi (sender_type === 'app') thì bỏ qua
    if (senderType === 'app') {
      return res.send({ code: 0 });
    }

    // Nếu đã trả lời rồi, bỏ qua (tránh Lark của railway retry gửi lại)
    if (answeredMessageIds.has(messageId)) {
      return res.send({ code: 0 });
    }

    // Lấy nội dung message user gửi
    let userMessage = '';
    try {
      const parsedContent = JSON.parse(decrypted.event.message.content);
      userMessage = parsedContent.text || '';
    } catch (e) {
      return res.send({ code: 0 });
    }

    // Bỏ qua tag @all/@everyone
    if (
      userMessage.includes('<at user_id="all">') ||
      userMessage.toLowerCase().includes('@all') ||
      userMessage.toLowerCase().includes('@everyone')
    ) {
      return res.send({ code: 0 });
    }

    // Xử lý chat với OpenRouter
    const userId = decrypted.event.sender.sender_id.user_id;
    try {
      // Lưu lịch sử (max 20 câu)
      if (!chatHistories[userId]) chatHistories[userId] = [];
      chatHistories[userId].push({ role: 'user', content: userMessage });
      if (chatHistories[userId].length > 20) {
        chatHistories[userId].splice(0, chatHistories[userId].length - 20);
      }

      // Gọi OpenRouter
      const chatResponse = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
          messages: [
            {
              role: 'system',
              content:
                'Bạn là một trợ lý AI thông minh, luôn trả lời chính xác, ngắn gọn và cập nhật thời gian hiện tại nếu được hỏi.',
            },
            ...chatHistories[userId],
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 8000, // timeout 8s cho chat
        }
      );

      const reply = chatResponse.data.choices[0].message.content;
      chatHistories[userId].push({ role: 'assistant', content: reply });

      // Gửi trả lời về Lark
      await replyToLark(messageId, reply);

      // Đánh dấu đã trả lời message này
      answeredMessageIds.add(messageId);
      // Giới hạn số lượng messageId lưu trong Set
      if (answeredMessageIds.size > 500) {
        const firstKey = answeredMessageIds.values().next().value;
        answeredMessageIds.delete(firstKey);
      }

      // Nếu trước đó đã gửi lỗi, xoá khỏi danh sách lỗi
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
      }
    }
  }

  return res.send({ code: 0 });
});

// ─── Khởi động server ─────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
