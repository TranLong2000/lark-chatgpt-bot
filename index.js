require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');

// Lấy tenant_access_token từ Lark
async function getTenantAccessToken() {
  const response = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET
    })
  });

  const data = await response.json();
  if (data.code !== 0) {
    console.error('[❌] Failed to get token:', data);
    return null;
  }

  console.log('[✅] Lấy token thành công');
  return data.tenant_access_token;
}

let tenantAccessToken = null;

// Hàm gửi message trả lời về Lark
async function replyToLarkMessage(openId, content) {
  if (!tenantAccessToken) {
    tenantAccessToken = await getTenantAccessToken();
  }

  const response = await fetch('https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tenantAccessToken}`
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text: content })
    })
  });

  const data = await response.json();
  if (data.code !== 0) {
    console.error('[❌] Lỗi khi gửi message:', data);
  } else {
    console.log('[✅] Đã gửi message thành công');
  }
}

// Tạo server Express
const app = express();
app.use(bodyParser.json());

// Endpoint webhook
app.post('/webhook', async (req, res) => {
  const { type, challenge, event } = req.body;

  // Bắt tay verify token
  if (type === 'url_verification') {
    return res.send({ challenge });
  }

  // Nhận message
  if (event && event.message) {
    const openId = event.sender.sender_id.open_id;
    const userMessage = event.message.content;

    console.log('[📩] Nhận message:', userMessage);

    // Gửi lại một câu trả lời mẫu
    await replyToLarkMessage(openId, 'Bot đã nhận được tin nhắn của bạn!');
  }

  res.sendStatus(200);
});

// Khởi động server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  tenantAccessToken = await getTenantAccessToken(); // Lấy token lần đầu
  console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
});
