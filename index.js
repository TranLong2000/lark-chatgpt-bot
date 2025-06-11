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
const port = process.env.PORT || 8080;

// Khai báo ánh xạ Base
const BASE_MAPPINGS = {
  'PRO': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tblClioOV3nPN6jM&view=vew7RMyPed',
  'FIN': 'https://cgfscmkep8m.sg.larksuite.com/base/Um8Zb07ayaDFAws9BRFlbZtngZf?table=tblc0IuDKdYrVGqo&view=vewU8BLeBr'
};

// Mặc định model AI, có thể thay đổi qua biến môi trường AI_MODEL
const AI_MODEL = process.env.AI_MODEL || 'deepseek/deepseek-r1-0528-qwen3-8b:free';

const processedMessageIds = new Set();
const conversationMemory = new Map();
const pendingTasks = new Map();

if (!fs.existsSync('temp_files')) {
  fs.mkdirSync('temp_files');
}

app.use('/webhook', express.raw({ type: '*/*' }));

function verifySignature(timestamp, nonce, body, signature) {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  if (!encryptKey) {
    console.error('[VerifySignature] LARK_ENCRYPT_KEY is not set');
    return false;
  }
  const raw = `${timestamp}${nonce}${encryptKey}${body}`;
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
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
    const tokenResp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`, {
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
  } catch (err) {
    console.error('[Reply Error]', err?.response?.data || err.message);
  }
}

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
    return sheet.map(row => row.join(', ')).join('; ');
  }

  if (['jpg', 'jpeg', 'png'].includes(fileType)) {
    const result = await Tesseract.recognize(buffer, 'eng');
    return result.data.text.trim();
  }

  return '';
}

async function extractImageContent(imageData) {
  const result = await Tesseract.recognize(imageData, 'eng');
  return result.data.text.trim();
}

async function getAppAccessToken() {
  const resp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`, {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  return resp.data.app_access_token;
}

async function getAllTables(baseId, token) {
  try {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    return resp.data.data.items.map(item => ({ tableId: item.table_id, name: item.name }));
  } catch (e) {
    console.error('[getAllTables] Error:', e.response?.data || e.message);
    return [];
  }
}

async function getAllRows(baseId, tableId, token, maxRows = 20) {
  const rows = [];
  let pageToken = '';
  do {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=20&page_token=${pageToken}`;
    try {
      console.log('[getAllRows] Fetching page, rows so far:', rows.length, 'for baseId:', baseId, 'tableId:', tableId);
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
      rows.push(...(resp.data.data.items || []));
      pageToken = resp.data.data.page_token || '';
      if (rows.length >= maxRows) break;
    } catch (e) {
      console.error('[getAllRows] Error:', e.response?.data || e.message);
      break;
    }
  } while (pageToken && rows.length < maxRows);
  console.log('[getAllRows] Total rows fetched:', rows.length);
  return rows;
}

function updateConversationMemory(chatId, role, content) {
  if (!conversationMemory.has(chatId)) {
    conversationMemory.set(chatId, []);
  }
  const mem = conversationMemory.get(chatId);
  mem.push({ role, content });
  if (mem.length > 10) mem.shift();
}

async function processBaseData(messageId, baseId, tableName, fieldName, userQuestion, token) {
  try {
    let allRows = [];
    const tables = await getAllTables(baseId, token);
    if (tables.length === 0) {
      await replyToLark(messageId, 'Không tìm thấy table nào trong Base.');
      return;
    }

    // Tìm table dựa trên tableName (tên table được cung cấp)
    const selectedTable = tables.find(t => t.name.toLowerCase().includes(tableName.toLowerCase()));
    if (!selectedTable) {
      await replyToLark(messageId, `Không tìm thấy table có tên liên quan đến '${tableName}'.`);
      return;
    }

    const rows = await getAllRows(baseId, selectedTable.tableId, token);
    allRows = allRows.concat(rows.map(row => row.fields || {}));

    if (!allRows || allRows.length === 0) {
      await replyToLark(messageId, 'Không có dữ liệu từ table.');
      return;
    }

    const validRows = allRows.filter(row => row && typeof row === 'object');
    if (validRows.length === 0) {
      await replyToLark(messageId, 'Không có hàng dữ liệu hợp lệ.');
      return;
    }

    const firstRow = validRows[0];
    const columns = Object.keys(firstRow || {});
    const tableData = { columns, rows: validRows };

    const chatId = pendingTasks.get(messageId)?.chatId;
    const memory = conversationMemory.get(chatId) || [];
    const aiResp = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: AI_MODEL,
        messages: [
          ...memory.map(({ role, content }) => ({ role, content })),
          {
            role: 'user',
            content: `Dữ liệu bảng từ Base ${baseId}, Table ${selectedTable.name} (${selectedTable.tableId}):\n${JSON.stringify(tableData, null, 2)}\nCâu hỏi: ${userQuestion}\nĐã cung cấp field quan tâm: ${fieldName}\nHãy phân tích dữ liệu, ưu tiên chọn cột có tên liên quan đến '${fieldName}' để trả lời câu hỏi. Nếu không tìm thấy cột phù hợp, tự động chọn cột khác phù hợp nhất. Trả lời chính xác dựa trên cột được chọn, không thêm định dạng như dấu * hoặc markdown.`
          }
        ],
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );

    const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, không có câu trả lời.';
    const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
    updateConversationMemory(chatId, 'user', userQuestion);
    updateConversationMemory(chatId, 'assistant', cleanMessage);
    await replyToLark(messageId, cleanMessage);
  } catch (e) {
    console.error('[Base API Error]', e?.response?.data || e.message);
    await replyToLark(messageId, '❌ Lỗi khi xử lý, thử lại sau.');
  } finally {
    pendingTasks.delete(messageId);
  }
}

// Xử lý tín hiệu dừng
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down...');
  pendingTasks.forEach((task, messageId) => replyToLark(messageId, 'Xử lý bị gián đoạn.'));
  process.exit(0);
});

setInterval(() => {
  conversationMemory.clear();
  console.log('[Memory] Cleared');
}, 2 * 60 * 60 * 1000);

app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const bodyRaw = req.body.toString('utf8');

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      return res.status(401).send('Invalid signature');
    }

    const { encrypt } = JSON.parse(bodyRaw);
    const decrypted = decryptMessage(encrypt);

    if (decrypted.header.event_type === 'url_verification') {
      return res.json({ challenge: decrypted.event.challenge });
    }

    if (decrypted.header.event_type === 'im.message.receive_v1') {
      const senderId = decrypted.event.sender.sender_id.open_id;
      const message = decrypted.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const messageType = message.message_type;

      if (processedMessageIds.has(messageId)) return res.send({ code: 0 });
      processedMessageIds.add(messageId);

      if (senderId === (process.env.BOT_SENDER_ID || '')) return res.send({ code: 0 });

      let userMessage = '';
      try {
        const parsed = JSON.parse(message.content);
        userMessage = parsed.text || '';
      } catch {}

      res.send({ code: 0 });

      const token = await getAppAccessToken();

      let baseId = '';
      let tableName = '';
      let fieldName = '';
      let userQuestion = '';

      // Trích xuất Base, Table, Field từ cú pháp "base, table, field, câu hỏi"
      const match = userMessage.match(/(\w+),\s*(\w+),\s*(\w+),\s*(.+)/i);
      if (match) {
        const baseName = match[1].toUpperCase();
        const baseUrl = BASE_MAPPINGS[baseName];
        if (baseUrl) {
          const urlMatch = baseUrl.match(/base\/([a-zA-Z0-9]+)/);
          baseId = urlMatch ? urlMatch[1] : '';
          tableName = match[2];
          fieldName = match[3];
          userQuestion = match[4].trim();
        } else {
          await replyToLark(messageId, 'Base không được hỗ trợ. Vui lòng dùng Base PRO hoặc Base FIN.');
          return;
        }
      }

      if (baseId && tableName && fieldName && userQuestion) {
        pendingTasks.set(messageId, { chatId, userMessage });
        processBaseData(messageId, baseId, tableName, fieldName, userQuestion, token).catch(err => console.error('[Task Error]', err.message));
      } else if (messageType === 'file' || messageType === 'image') {
        try {
          const fileKey = message.file_key;
          const fileName = message.file_name || `${messageId}.${messageType === 'image' ? 'jpg' : 'bin'}`;
          const ext = fileName.split('.').pop().toLowerCase();

          const fileUrlResp = await axios.get(
            `${process.env.LARK_DOMAIN}/open-apis/im/v1/files/${fileKey}/download_url`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const fileUrl = fileUrlResp.data.data.download_url;

          const extractedText = await extractFileContent(fileUrl, ext);

          if (extractedText.length === 0) {
            await replyToLark(messageId, 'Không thể trích xuất nội dung từ file.');
          } else {
            updateConversationMemory(chatId, 'user', `File ${fileName}: nội dung trích xuất.`);
            updateConversationMemory(chatId, 'assistant', extractedText);
            await replyToLark(messageId, `Nội dung file ${fileName}:\n${extractedText.slice(0, 1000)}${extractedText.length > 1000 ? '...' : ''}`);
          }
        } catch (e) {
          console.error('[File Processing Error]', e?.response?.data?.msg || e.message);
          await replyToLark(messageId, '❌ Lỗi khi xử lý file.');
        }
      } else if (messageType === 'post') {
        try {
          const parsedContent = JSON.parse(message.content);
          let textContent = '';
          let imageKey = '';

          for (const block of parsedContent.content) {
            for (const item of block) {
              if (item.tag === 'text') textContent += item.text + ' ';
              else if (item.tag === 'img') imageKey = item.image_key;
            }
          }
          textContent = textContent.trim();

          let extractedText = '';
          if (imageKey) {
            try {
              const imageUrl = `${process.env.LARK_DOMAIN}/open-apis/im/v1/images/${imageKey}`;
              const imageResp = await axios.get(imageUrl, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
                responseType: 'arraybuffer',
              });
              extractedText = await extractImageContent(Buffer.from(imageResp.data));
            } catch (imageError) {
              try {
                const resourceUrl = `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages/${messageId}/resources`;
                const resourceResp = await axios.post(resourceUrl, {}, {
                  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
                });
                if (resourceResp.data.data.file_list && resourceResp.data.file_list.length > 0) {
                  const fileUrl = resourceResp.data.data.file_list[0].download_url;
                  const imageData = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                  extractedText = await extractImageContent(Buffer.from(imageData.data));
                }
              } catch (resourceError) {
                console.error('[Post] Error fetching resource:', resourceError?.response?.data?.msg || resourceError.message);
              }
            }
          }

          const combinedMessage = textContent + (extractedText ? `\nNội dung từ hình ảnh: ${extractedText}` : '');
          if (combinedMessage.length === 0) {
            await replyToLark(messageId, 'Không trích xuất được nội dung.');
            return;
          }

          updateConversationMemory(chatId, 'user', combinedMessage);
          const memory = conversationMemory.get(chatId) || [];
          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: AI_MODEL,
              messages: [...memory.map(({ role, content }) => ({ role, content })), { role: 'user', content: combinedMessage }],
              stream: false,
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
              },
            }
          );

          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, không có câu trả lời.';
          const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
          updateConversationMemory(chatId, 'assistant', cleanMessage);
          await replyToLark(messageId, cleanMessage);
        } catch (e) {
          console.error('[Post Processing Error]', e?.response?.data?.msg || e.message);
          await replyToLark(messageId, '❌ Lỗi khi xử lý post.');
        }
      } else if (messageType === 'text' && userMessage.trim().length > 0) {
        try {
          updateConversationMemory(chatId, 'user', userMessage);
          const memory = conversationMemory.get(chatId) || [];
          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: AI_MODEL,
              messages: [...memory.map(({ role, content }) => ({ role, content })), { role: 'user', content: userMessage }],
              stream: false,
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
              },
            }
          );

          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, không có câu trả lời.';
          const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
          updateConversationMemory(chatId, 'assistant', cleanMessage);
          await replyToLark(messageId, cleanMessage);
        } catch (e) {
          console.error('[AI Error]', e?.response?.data?.msg || e.message);
          await replyToLark(messageId, '❌ Lỗi khi gọi AI.');
        }
      }
    }
  } catch (e) {
    console.error('[Webhook Handler Error]', e.message);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
