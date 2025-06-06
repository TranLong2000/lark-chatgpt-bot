// index.js
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const processedMessageIds = new Set();

// Middleware cho webhook
app.use('/webhook', express.raw({ type: '*/*' }));

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

async function getAppAccessToken() {
  const resp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`, {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  return resp.data.app_access_token;
}

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
      }
    );
  } catch (err) {
    console.error('[Reply Error]', err?.response?.data || err.message);
  }
}

async function fetchAllTables(token) {
  const res = await axios.get(
    `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${process.env.LARK_BASE_APP_TOKEN}/tables`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  return res.data.data.items || [];
}

async function fetchRecords(token, tableId) {
  const res = await axios.get(
    `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${process.env.LARK_BASE_APP_TOKEN}/tables/${tableId}/records?page_size=20`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  return res.data.data.items || [];
}

function formatRecords(records) {
  return records
    .map((r, idx) => `${idx + 1}. ${JSON.stringify(r.fields)}`)
    .join('\n\n');
}

app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const bodyRaw = req.body.toString();

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      console.error('[Webhook] Invalid signature');
      return res.status(401).send('Invalid signature');
    }

    const { encrypt } = JSON.parse(bodyRaw);
    const decrypted = decryptMessage(encrypt);
    console.log('[Webhook] Event:', decrypted.header.event_type);

    if (decrypted.header.event_type === 'url_verification') {
      return res.send({ challenge: decrypted.event.challenge });
    }

    if (decrypted.header.event_type === 'im.message.receive_v1') {
      const message = decrypted.event.message;
      const messageId = message.message_id;
      const messageType = message.message_type;

      if (processedMessageIds.has(messageId)) return res.send({ code: 0 });
      processedMessageIds.add(messageId);

      if (messageType !== 'text') return res.send({ code: 0 });

      const text = JSON.parse(message.content).text || '';
      if (!text.includes('xem base')) return res.send({ code: 0 });

      const token = await getAppAccessToken();
      const tables = await fetchAllTables(token);

      let allData = '';
      for (const table of tables) {
        const records = await fetchRecords(token, table.table_id);
        allData += `\n\n[Bảng: ${table.name}]\n` + formatRecords(records);
      }

      await replyToLark(messageId, allData || 'Không có dữ liệu.');
      return res.send({ code: 0 });
    }

    res.send({ code: 0 });
  } catch (err) {
    console.error('[Webhook Error]', err);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Bot is running on port ${port}`);
});
