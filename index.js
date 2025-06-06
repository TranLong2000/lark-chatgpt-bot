const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const Tesseract = require('tesseract.js');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const processedMessageIds = new Set();
const pendingFiles = new Map();

// Bộ nhớ hội thoại theo chat_id, lưu trữ mảng message {role, content}, tự động xóa sau 2h
const conversationMemory = new Map();

if (!fs.existsSync('temp_files')) {
  fs.mkdirSync('temp_files');
}

// Middleware parse raw cho webhook Lark
app.use('/webhook', express.raw({ type: '*/*' }));

// Xác thực chữ ký webhook Lark
function verifySignature(timestamp, nonce, body, signature) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  const raw = `${timestamp}${nonce}${encryptKey}${body}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return hash === signature;
}

// Giải mã message encrypt Lark (AES-256-CBC)
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

// Gửi reply tới Lark message
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
    console.log('[Webhook] Reply sent');
  } catch (err) {
    console.error('[Reply Error]', err?.response?.data || err.message);
  }
}

// Trích xuất nội dung file theo loại file
async function extractFileContent(fileUrl, fileType) {
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);

  if (fileType === 'pdf') {
    const data = await pdfParse(buffer);
    return data.text.trim();
  }

  if (fileType === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  }

  if (fileType === 'xlsx') {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
    return sheet.map(row => row.join(' ')).join('\n');
  }

  if (['jpg', 'jpeg', 'png', 'bmp'].includes(fileType)) {
    const result = await Tesseract.recognize(buffer, 'eng+vie');
    return result.data.text.trim();
  }

  return '';
}

// Lấy Access Token app nội bộ
async function getAppAccessToken() {
  const resp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal/`, {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  return resp.data.app_access_token;
}

// Lấy danh sách bảng trong Base
async function getAllTables(baseId, token) {
  const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.data.data.items; // mảng bảng
}

// Lấy dữ liệu toàn bộ bảng
async function getAllRows(baseId, tableId, token) {
  const rows = [];
  let pageToken = '';
  do {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=100&page_token=${pageToken}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    rows.push(...resp.data.data.items);
    pageToken = resp.data.data.page_token || '';
  } while (pageToken);
  return rows;
}

// Cập nhật bộ nhớ hội thoại theo chat_id
function updateConversationMemory(chatId, role, content) {
  if (!conversationMemory.has(chatId)) {
    conversationMemory.set(chatId, []);
  }
  const mem = conversationMemory.get(chatId);
  mem.push({ role, content });
  // Giới hạn max 50 tin nhắn trong bộ nhớ để tránh quá lớn
  if (mem.length > 50) {
    mem.shift();
  }
}

// Xóa bộ nhớ cũ hơn 2h (clear toàn bộ bộ nhớ)
setInterval(() => {
  conversationMemory.clear();
  console.log('[Memory] Cleared conversation memory (2h interval)');
}, 2 * 60 * 60 * 1000);

// Main webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const bodyRaw = req.body.toString();

    // Kiểm tra chữ ký webhook
    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      console.error('[Webhook] Invalid signature');
      return res.status(401).send('Invalid signature');
    }

    const { encrypt } = JSON.parse(bodyRaw);
    const decrypted = decryptMessage(encrypt);
    console.log('[Webhook] Decrypted event:', JSON.stringify(decrypted, null, 2));

    // Xử lý url_verification (để xác thực webhook)
    if (decrypted.header.event_type === 'url_verification') {
      return res.send({ challenge: decrypted.event.challenge });
    }

    // Xử lý tin nhắn mới
    if (decrypted.header.event_type === 'im.message.receive_v1') {
      const senderId = decrypted.event.sender.sender_id.open_id;
      const message = decrypted.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const chatType = message.chat_type;
      const messageType = message.message_type;

      if (processedMessageIds.has(messageId)) return res.send({ code: 0 });
      processedMessageIds.add(messageId);

      // Bỏ qua tin nhắn do bot gửi (tránh vòng lặp)
      if (senderId === (process.env.BOT_SENDER_ID || '')) return res.send({ code: 0 });

      let userMessage = '';
      try {
        const parsed = JSON.parse(message.content);
        userMessage = parsed.text || '';
      } catch {}

      const token = await getAppAccessToken();

      // --- XỬ LÝ LẤY DỮ LIỆU BASE TỪ TIN NHẮN ---

      // Nếu tin nhắn có chứa link Base hoặc câu lệnh yêu cầu đọc Base
      const baseId = process.env.LARK_BASE_ID || ''; // set biến môi trường LARK_BASE_ID cho Base chính
      const baseLinkMatch = userMessage.match(/https:\/\/[^\s]+\/base\/([a-zA-Z0-9]+)(?:\?table=([a-zA-Z0-9]+))?/);
      const explicitTableIdMatch = userMessage.match(/tbl61rgzOwS8viB2/);

      if (baseLinkMatch || explicitTableIdMatch) {
        const baseIdFromMsg = baseLinkMatch ? baseLinkMatch[1] : baseId;
        const tableIdFromMsg = baseLinkMatch ? baseLinkMatch[2] : 'tbl61rgzOwS8viB2';

        try {
          // Nếu có tableId cụ thể thì chỉ lấy bảng đó, ngược lại lấy toàn bộ bảng
          let tables = [];
          if (tableIdFromMsg) {
            tables = [
              {
                table_id: tableIdFromMsg,
                name: `Bảng theo ID: ${tableIdFromMsg}`,
                type: 'base_table',
              },
            ];
          } else {
            tables = await getAllTables(baseIdFromMsg, token);
          }

          let baseSummary = `Dữ liệu Base ID: ${baseIdFromMsg}\n`;

          // Duyệt tất cả bảng hoặc bảng được chỉ định
          for (const table of tables) {
            if (table.type === 'base_table') {
              baseSummary += `\nBảng: ${table.name} (ID: ${table.table_id})\n`;

              const rows = await getAllRows(baseIdFromMsg, table.table_id, token);

              if (rows.length === 0) {
                baseSummary += '  (Không có bản ghi)\n';
                continue;
              }

              // Lấy tối đa 10 bản ghi đầu để tránh quá dài
              const sampleRows = rows.slice(0, 10);

              for (const row of sampleRows) {
                const fieldsText = Object.entries(row.fields).map(([k, v]) => `${k}: ${v}`).join('; ');
                baseSummary += `  - ${fieldsText}\n`;
              }
              if (rows.length > 10) baseSummary += `  ... (${rows.length} bản ghi)\n`;
            }
          }

          // Cập nhật bộ nhớ hội thoại
          updateConversationMemory(chatId, 'user', userMessage);
          updateConversationMemory(chatId, 'assistant', baseSummary);

          await replyToLark(messageId, baseSummary);
        } catch (e) {
          console.error('[Base API Error]', e?.response?.data || e.message);
          await replyToLark(messageId, '❌ Lỗi khi truy xuất Base, vui lòng kiểm tra quyền hoặc thử lại sau.');
        }

        return res.send({ code: 0 });
      }

      // --- XỬ LÝ FILE HOẶC ẢNH ĐƯỢC GỬI ---

      if (messageType === 'file' || messageType === 'image') {
        try {
          const fileKey = message.file_key;
          const fileName = message.file_name || `${messageId}.${messageType === 'image' ? 'jpg' : 'bin'}`;
          const ext = fileName.split('.').pop().toLowerCase();

          const fileResp = await axios.get(
            `${process.env.LARK_DOMAIN}/open-apis/drive/v1/files/${fileKey}/download_url`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );

          const url = fileResp.data.data.url;

          pendingFiles.set(messageId, {
            url,
            ext,
            name: fileName,
            timestamp: Date.now(),
          });

          await replyToLark(messageId, '✅ Đã lưu file. Vui lòng *reply* vào tin nhắn này để tôi đọc nội dung.');
        } catch (e) {
          console.error('[File/Image Error]', e.message);
          await replyToLark(messageId, '❌ Lỗi khi lấy file, vui lòng thử lại.');
        }
        return res.send({ code: 0 });
      }

      // --- XỬ LÝ REPLY VÀO TIN NHẮN FILE ĐỂ ĐỌC NỘI DUNG FILE ---

      if (messageType === 'text') {
        try {
          const parsed = JSON.parse(message.content);
          const text = parsed.text || '';
          const rootId = decrypted.event.root_id || '';
          if (rootId && pendingFiles.has(rootId)) {
            // Người dùng reply tin nhắn file để đọc file
            const fileInfo = pendingFiles.get(rootId);
            if (!fileInfo) {
              await replyToLark(messageId, '❌ Không tìm thấy file đính kèm để đọc.');
              return res.send({ code: 0 });
            }

            const content = await extractFileContent(fileInfo.url, fileInfo.ext);
            if (!content) {
              await replyToLark(messageId, '❌ Không thể đọc nội dung file hoặc file trống.');
              return res.send({ code: 0 });
            }

            updateConversationMemory(chatId, 'user', `Đọc nội dung file ${fileInfo.name}`);
            updateConversationMemory(chatId, 'assistant', content);

            await replyToLark(messageId, `Nội dung file:\n${content.slice(0, 2000)}`); // Giới hạn 2000 ký tự

            pendingFiles.delete(rootId);
            return res.send({ code: 0 });
          }
        } catch (e) {}
      }

      // --- XỬ LÝ TIN NHẮN THƯỜNG (GỌI AI DEEPSEEK CÙNG DỮ LIỆU BASE) ---

      if (!userMessage || userMessage.trim().length === 0) {
        return res.send({ code: 0 });
      }

      if (!baseId) {
        await replyToLark(messageId, '❌ Chưa cấu hình biến môi trường LARK_BASE_ID để lấy dữ liệu Base.');
        return res.send({ code: 0 });
      }

      try {
        // Lấy danh sách bảng Base
        const tables = await getAllTables(baseId, token);

        // Lấy dữ liệu tất cả bảng (max 100 bản ghi mỗi bảng)
        const allData = {};
        for (const table of tables) {
          const rows = await getAllRows(baseId, table.table_id, token);
          allData[table.name] = rows.slice(0, 100).map(row => row.fields);
        }

        // Tạo đoạn text dữ liệu Base cho prompt AI
        let baseDataText = 'Dữ liệu Base gồm các bảng sau:\n';
        for (const [tableName, records] of Object.entries(allData)) {
          baseDataText += `\nBảng: ${tableName}\n`;
          if (records.length === 0) {
            baseDataText += '(Không có bản ghi)\n';
          } else {
            records.slice(0, 5).forEach((rec, i) => {
              baseDataText += `  #${i + 1}: ${JSON.stringify(rec)}\n`;
            });
            if (records.length > 5) baseDataText += `  ... (${records.length} bản ghi)\n`;
          }
        }

        // Lấy bộ nhớ hội thoại
        const history = conversationMemory.get(chatId) || [];

        // Tạo mảng message cho AI
        const messagesForAI = [
          { role: 'system', content: 'Bạn là trợ lý giúp phân tích dữ liệu từ Base của Lark.' },
          { role: 'system', content: baseDataText },
          ...history,
          { role: 'user', content: userMessage },
        ];

        // Gọi OpenRouter AI deepseek-r1
        const aiResp = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
            messages: messagesForAI,
            temperature: 0.2,
            top_p: 0.95,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );

        const assistantReply = aiResp.data.choices[0].message.content;

        updateConversationMemory(chatId, 'user', userMessage);
        updateConversationMemory(chatId, 'assistant', assistantReply);

        await replyToLark(messageId, assistantReply);
      } catch (e) {
        console.error('[AI Base Query Error]', e?.response?.data || e.message);
        await replyToLark(messageId, '❌ Lỗi khi truy vấn dữ liệu Base hoặc gọi AI, vui lòng thử lại sau.');
      }

      return res.send({ code: 0 });
    }

    return res.send({ code: 0 });
  } catch (e) {
    console.error('[Webhook Error]', e);
    return res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
