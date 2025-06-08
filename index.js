require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Kiểm tra biến môi trường
const requiredEnvVars = [
  'OPENROUTER_API_KEY',
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  'LARK_VERIFICATION_TOKEN',
  'LARK_ENCRYPT_KEY',
  'LARK_DOMAIN',
  'BOT_SENDER_ID',
];
const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.warn(`Missing environment variables: ${missingEnvVars.join(', ')}. Application may not function correctly.`);
}

// Bộ nhớ chat
const chatMemories = {};
function cleanOldMemory() {
  const now = Date.now();
  for (const key in chatMemories) {
    if (now - chatMemories[key].updatedAt > 2 * 60 * 60 * 1000) { // 2 giờ
      delete chatMemories[key];
    }
  }
}
setInterval(cleanOldMemory, 10 * 60 * 1000); // Kiểm tra mỗi 10 phút

// Health check endpoint cho Railway
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).send('OK');
});

// Hàm giải mã webhook
function decryptWebhook(encryptedData, key) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(key, 'base64'),
      Buffer.alloc(16, 0)
    );
    let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Failed to decrypt webhook:', error.message, error.stack);
    return null;
  }
}

// Xử lý webhook từ Lark
app.post('/webhook', async (req, res) => {
  let body = req.body;
  console.log('Received webhook:', JSON.stringify(body, null, 2));

  // Giải mã nếu webhook được mã hóa
  if (body.encrypt && process.env.LARK_ENCRYPT_KEY) {
    console.log('Decrypting webhook');
    body = decryptWebhook(body.encrypt, process.env.LARK_ENCRYPT_KEY);
    if (!body) {
      console.log('Ignored: Failed to decrypt webhook');
      return res.status(400).send('Failed to decrypt webhook');
    }
    console.log('Decrypted webhook:', JSON.stringify(body, null, 2));
  }

  // Xác minh webhook
  if (body.type === 'url_verification' && process.env.LARK_VERIFICATION_TOKEN && body.token === process.env.LARK_VERIFICATION_TOKEN) {
    console.log('Webhook verification successful');
    return res.json({ challenge: body.challenge });
  }

  // Xử lý tin nhắn
  if (body.header && body.header.event_type === 'im.message.receive_v1' && body.event.message.content) {
    try {
      console.log('Processing message event');
      const content = JSON.parse(body.event.message.content);
      if (!content.text) {
        console.log('Ignored: Not a text message');
        return res.status(200).send('Ignored: Not a text message');
      }

      const chatId = body.event.message.chat_id;
      const userId = body.event.sender.sender_id.open_id;
      const messageId = body.event.message.message_id;
      const question = content.text.trim();

      console.log(`Message details - chatId: ${chatId}, userId: ${userId}, messageId: ${messageId}, question: ${question}`);

      if (!question) {
        console.log('Ignored: Empty message');
        return res.status(200).send('Ignored: Empty message');
      }

      if (userId === process.env.BOT_SENDER_ID) {
        console.log('Ignored: Message from bot');
        return res.status(200).send('Ignored: Message from bot');
      }

      if (!process.env.OPENROUTER_API_KEY) {
        console.log('Missing OPENROUTER_API_KEY');
        await sendReply(chatId, '❌ Lỗi: Thiếu API key cho OpenRouter. Vui lòng liên hệ quản trị viên.');
        return res.status(200).send('Missing OPENROUTER_API_KEY');
      }

      // Gửi thông báo đang xử lý
      console.log('Sending processing message');
      await sendReply(chatId, '🤖 Đang xử lý câu hỏi của bạn...');

      // Gửi yêu cầu đến OpenRouter API
      console.log('Sending request to OpenRouter API');
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
          messages: [
            {
              role: 'system',
              content: 'Bạn là một trợ lý AI thông minh, trả lời chính xác và hữu ích bằng tiếng Việt.',
            },
            {
              role: 'user',
              content: question,
            },
          ],
          max_tokens: 1000,
          temperature: 0.7,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const reply = response.data.choices[0].message.content.trim();
      console.log(`Received reply from OpenRouter: ${reply}`);

      // Cập nhật bộ nhớ chat
      chatMemories[chatId] = {
        memory: (chatMemories[chatId]?.memory || '').slice(-2000) + `\nQ: ${question}\nA: ${reply}`,
        updatedAt: Date.now(),
      };

      // Gửi phản hồi
      console.log('Sending reply to Lark');
      await sendReply(chatId, reply);

      res.status(200).send('OK');
    } catch (error) {
      console.error('Error processing message:', error.message, error.stack);
      await sendReply(chatId, '❌ Có lỗi xảy ra khi xử lý câu hỏi. Vui lòng thử lại sau.');
      res.status(500).send('Error processing message');
    }
  } else {
    console.log('Ignored: Not a valid message event');
    res.status(200).send('Ignored: Not a valid message event');
  }
});

// Hàm gửi phản hồi qua Lark
async function sendReply(chatId, text) {
  if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET || !process.env.LARK_DOMAIN) {
    console.error('Cannot send reply: Missing Lark credentials');
    return;
  }

  try {
    console.log(`Sending reply to chatId: ${chatId}, text: ${text}`);
    const accessToken = await getTenantAccessToken();
    await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages`,
      {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Receive-Id-Type': 'chat_id',
        },
      }
    );
    console.log('Reply sent successfully');
  } catch (error) {
    console.error('Failed to send reply:', error.message, error.stack);
  }
}

// Hàm lấy tenant access token
async function getTenantAccessToken() {
  try {
    console.log('Requesting tenant access token');
    const res = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }
    );
    console.log('Tenant access token received');
    return res.data.tenant_access_token;
  } catch (error) {
    console.error('Failed to get access token:', error.message, error.stack);
    throw error;
  }
}

// Khởi động server
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`🚀 Smart Lark AI Bot running at http://localhost:${PORT}`);
});

// Xử lý graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Performing graceful shutdown...');
  server.close(() => {
    console.log('Server closed. Exiting process...');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Performing graceful shutdown...');
  server.close(() => {
    console.log('Server closed. Exiting process...');
    process.exit(0);
  });
});
