import express from 'express';
import crypto from 'crypto';
import axios from 'axios';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  LARK_ENCRYPT_KEY,
} = process.env;

// In-memory store bộ nhớ hội thoại từng chat, tự động xóa sau 2h
const conversationMemory = new Map();

// Hàm lưu bộ nhớ chat
function saveConversationMemory(chatId, message) {
  if (!conversationMemory.has(chatId)) {
    conversationMemory.set(chatId, []);
  }
  conversationMemory.get(chatId).push({
    time: Date.now(),
    message,
  });
  // Dọn bộ nhớ > 2h
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const mem = conversationMemory.get(chatId);
  conversationMemory.set(
    chatId,
    mem.filter((m) => m.time > twoHoursAgo)
  );
}

// Hàm lấy bộ nhớ chat
function getConversationMemory(chatId) {
  if (!conversationMemory.has(chatId)) return [];
  return conversationMemory.get(chatId).map((m) => m.message);
}

// Xác thực webhook từ Lark (dùng Verification Token)
function verifyLarkEvent(req) {
  const token = req.headers['x-lark-request-token'];
  return token === LARK_VERIFICATION_TOKEN;
}

// Giải mã event mã hóa AES (nếu cần)
function decryptEvent(encryptStr) {
  const key = Buffer.from(LARK_ENCRYPT_KEY, 'base64');
  const iv = key.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptStr, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// Lấy app_access_token để gọi API
async function getAppAccessToken() {
  const resp = await axios.post(
    'https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal/',
    {
      app_id: LARK_APP_ID,
      app_secret: LARK_APP_SECRET,
    }
  );
  if (resp.data.code !== 0) {
    throw new Error(`Lấy app_access_token lỗi: ${resp.data.msg}`);
  }
  return resp.data.app_access_token;
}

// Gọi API lấy dữ liệu bảng Base
async function getBaseTableData(baseId, tableId, token) {
  const url = 'https://open.larksuite.com/open-apis/base/v1/table/records/query';
  const resp = await axios.post(
    url,
    {
      app_token: baseId,
      table_id: tableId,
      page_size: 10,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (resp.data.code !== 0) {
    throw new Error(`Lấy dữ liệu Base lỗi: ${resp.data.msg}`);
  }
  return resp.data.data;
}

// Gửi trả lời tin nhắn nhóm/chat
async function replyToLark(messageId, text) {
  const token = await getAppAccessToken();
  const url = 'https://open.larksuite.com/open-apis/im/v1/messages';

  // Lấy chat_id từ messageId (thường gửi kèm chat_id, ở đây giả định bạn có chat_id)
  // Nếu không có chat_id, bạn cần lưu chat_id trong webhook hoặc pass thêm tham số
  // Ở đây giả sử bạn gọi hàm này trong webhook, có chat_id

  // Vì API trả lời cần chat_id và message_id để reply
  // Mình sẽ thay đổi hàm replyToLark để nhận thêm chat_id:
  throw new Error(
    'replyToLark cần chat_id, hãy gọi hàm replyToLark(messageId, chatId, text)'
  );
}

async function replyToLarkWithChatId(messageId, chatId, text) {
  const token = await getAppAccessToken();
  const url = 'https://open.larksuite.com/open-apis/im/v1/messages';

  const resp = await axios.post(
    url,
    {
      chat_id: chatId,
      root_id: messageId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (resp.data.code !== 0) {
    console.error('Gửi trả lời Lark lỗi:', resp.data);
  }
  return resp.data;
}

app.post('/webhook', async (req, res) => {
  try {
    // 1. Verify token
    if (!verifyLarkEvent(req)) {
      return res.status(401).send('Unauthorized');
    }

    // 2. Parse event (decrypt nếu cần)
    let eventObj = req.body;
    if (eventObj.encrypt) {
      eventObj = decryptEvent(eventObj.encrypt);
    }

    // 3. Xử lý event
    if (eventObj.header.event_type === 'im.message.receive_v1') {
      const event = eventObj.event;
      const message = event.message;
      const chatId = message.chat_id;
      const messageId = message.message_id;
      const contentStr = message.content;

      // Lấy text trong content JSON
      let userText = '';
      try {
        userText = JSON.parse(contentStr).text;
      } catch {
        userText = contentStr;
      }

      // Kiểm tra có mention bot không
      const mentions = message.mentions || [];
      const botOpenId = 'ou_28e2a5e298050b5f08899314b2d49300'; // Thay bằng OpenID bot của bạn
      const botMentioned = mentions.some((m) => m.id.open_id === botOpenId);

      if (!botMentioned) {
        // Không mention bot, không xử lý
        return res.send({ code: 0 });
      }

      // Lưu bộ nhớ hội thoại (chat)
      saveConversationMemory(chatId, userText);

      // Kiểm tra xem userText có chứa link Base
      const baseIdMatch = userText.match(/base\/([a-zA-Z0-9]+)\?/);
      const tableIdMatch = userText.match(/table=([a-zA-Z0-9]+)/);

      if (!baseIdMatch || !tableIdMatch) {
        await replyToLarkWithChatId(
          messageId,
          chatId,
          '❌ Không tìm thấy Base ID hoặc Table ID trong tin nhắn.'
        );
        return res.send({ code: 0 });
      }

      const baseId = baseIdMatch[1];
      const tableId = tableIdMatch[1];

      try {
        const token = await getAppAccessToken();
        const data = await getBaseTableData(baseId, tableId, token);

        const records = data.items || [];
        if (records.length === 0) {
          await replyToLarkWithChatId(
            messageId,
            chatId,
            `Base ${baseId} bảng ${tableId} chưa có dữ liệu.`
          );
        } else {
          let replyText = `Dữ liệu Base ${baseId}, bảng ${tableId} (tối đa 5 dòng):\n`;
          records.slice(0, 5).forEach((rec, i) => {
            replyText += `\n#${i + 1}:\n`;
            Object.entries(rec.values).forEach(([k, v]) => {
              replyText += `- ${k}: ${v}\n`;
            });
          });
          await replyToLarkWithChatId(messageId, chatId, replyText);
        }
      } catch (e) {
        await replyToLarkWithChatId(
          messageId,
          chatId,
          `❌ Lỗi khi lấy dữ liệu Base: ${e.message}`
        );
      }

      return res.send({ code: 0 });
    }

    // Các event khác trả về code 0 để xác nhận
    res.send({ code: 0 });
  } catch (e) {
    console.error('Lỗi webhook:', e);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
