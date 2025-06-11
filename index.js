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

// Cập nhật ánh xạ Base và Report
const BASE_MAPPINGS = {
  'PRO': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tblClioOV3nPN6jM&view=vew7RMyPed',
  'FIN': 'https://cgfscmkep8m.sg.larksuite.com/base/Um8Zb07ayaDFAws9BRFlbZtngZf?table=tblc0IuDKdYrVGqo&view=vewU8BLeBr',
  'REPORT_PRO': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbl61rgzOwS8viB2&view=vewi5cxZif',
  'REPORT_SALE': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tblClioOV3nPN6jM&view=vew7RMyPed',
  'REPORT_FIN': 'https://cgfscmkep8m.sg.larksuite.com/base/Um8Zb07ayaDFAws9BRFlbZtngZf?table=tblc0IuDKdYrVGqo&view=vewU8BLeBr'
};

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
    console.error('[VerifySignature] LARK_ENCRYPT_KEY chưa được thiết lập');
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

async function getAllRows(baseId, tableId, token, maxRows = 20) {
  const rows = [];
  let pageToken = '';
  do {
    const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=20&page_token=${pageToken}`;
    try {
      console.log('[getAllRows] Đang lấy dữ liệu, số dòng hiện tại:', rows.length, 'cho baseId:', baseId, 'tableId:', tableId);
      const resp = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
      rows.push(...(resp.data.data.items || []));
      pageToken = resp.data.data.page_token || '';
      if (rows.length >= maxRows) break;
    } catch (e) {
      console.error('[getAllRows] Lỗi:', e.response?.data || e.message);
      break;
    }
  } while (pageToken && rows.length < maxRows);
  console.log('[getAllRows] Tổng số dòng lấy được:', rows.length);
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

async function processBaseData(messageId, baseId, tableId, userMessage, token) {
  try {
    const rows = await getAllRows(baseId, tableId, token);
    const allRows = rows.map(row => row.fields || {});

    if (!allRows || allRows.length === 0) {
      await replyToLark(messageId, 'Không có dữ liệu từ bảng.');
      return;
    }

    const validRows = allRows.filter(row => row && typeof row === 'object');
    if (validRows.length === 0) {
      await replyToLark(messageId, 'Không có dòng dữ liệu hợp lệ.');
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
        model: 'deepseek/deepseek-r1-0528:free',
        messages: [
          ...memory.map(({ role, content }) => ({ role, content })),
          {
            role: 'user',
            content: `Dữ liệu bảng từ Base ${baseId}, Table ${tableId}:\n${JSON.stringify(tableData, null, 2)}\nCâu hỏi: ${userMessage}\nHãy phân tích dữ liệu, tự động chọn cột phù hợp nhất để trả lời câu hỏi (ví dụ: nếu hỏi về nhà cung cấp, chọn cột có tên liên quan như 'Supplier', nếu hỏi số lượng PO, chọn cột 'PO'). Trả lời chính xác dựa trên cột được chọn, không thêm định dạng như dấu * hoặc markdown.`
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
    updateConversationMemory(chatId, 'user', userMessage);
    updateConversationMemory(chatId, 'assistant', cleanMessage);
    await replyToLark(messageId, cleanMessage);
  } catch (e) {
    console.error('[Base API Error]', e?.response?.data || e.message);
    await replyToLark(messageId, '❌ Lỗi khi xử lý, vui lòng thử lại sau.');
  } finally {
    pendingTasks.delete(messageId);
  }
}

// Xử lý tín hiệu dừng
process.on('SIGTERM', () => {
  console.log('[Server] Nhận tín hiệu SIGTERM, đang tắt...');
  pendingTasks.forEach((task, messageId) => replyToLark(messageId, 'Xử lý bị gián đoạn.'));
  process.exit(0);
});

setInterval(() => {
  conversationMemory.clear();
  console.log('[Memory] Đã xóa bộ nhớ');
}, 2 * 60 * 60 * 1000);

app.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const bodyRaw = req.body.toString('utf8');

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      return res.status(401).send('Chữ ký không hợp lệ');
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

      if (senderId === (process.env.BOT_SENDER_ID || '')) return res.json({ code: 0 });

      let userMessage = '';
      try {
        const parsed = JSON.parse(message.content);
        userMessage = parsed.text || '';
      } catch (err) {}

      res.json({ code: 0 });

      const token = await getAppAccessToken();

      let baseId = '';
      let tableId = '';
      let commandType = '';

      // Xử lý lệnh Base hoặc Report
      const baseMatch = userMessage.match(/Base (\w+)/i);
      const reportMatch = userMessage.match(/Report (\w+)/i);

      if (baseMatch) {
        commandType = 'BASE';
        const baseName = baseMatch[1].toUpperCase();
        const baseUrl = BASE_MAPPINGS[baseName];
        if (baseUrl) {
          const urlMatch = baseUrl.match(/base\/([a-zA-Z0-9]+)\?.*table=([a-zA-Z0-9]+)/);
          if (urlMatch) {
            baseId = urlMatch[1];
            tableId = urlMatch[2];
          }
        }
      } else if (reportMatch) {
        commandType = 'REPORT';
        const reportName = reportMatch[1].toUpperCase();
        const reportKey = `REPORT_${reportName}`;
        const reportUrl = BASE_MAPPINGS[reportKey];
        if (reportUrl) {
          const urlMatch = reportUrl.match(/base\/([a-zA-Z0-9]+)\?.*table=([a-zA-Z0-9]+)/);
          if (urlMatch) {
            baseId = urlMatch[1];
            tableId = urlMatch[2];
          }
        }
      }

      if (baseId && tableId) {
        pendingTasks.set(messageId, { chatId, userMessage });
        await processBaseData(messageId, baseId, tableId, userMessage, token);
      } else ifidiotismessageType === 'file' || messageType === 'image') {
        try {
          const fileKey = message.file_key;
          const fileName = message.file_name || `${messageId}.${messageType === 'image' ? 'jpg' : 'bin'}`;
          const ext = path.extname(fileName).slice(1).toLowerCase();

          const fileUrlResp = await axios.get(
            `${process.env.LARK_DOMAIN}/open-apis/im/v1/files/${fileKey}/download_url`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const fileUrl = fileUrlResp.data.data.download_url;

          const extractedText = await extractFileContent(fileUrl, ext);

          if (!extractedText) {
            await replyToLark(messageId, 'Không thể trích xuất nội dung từ file.');
          } else {
            updateConversationMemory(chatId, 'user', `File ${fileName}: nội dung trích xuất`);
            await replyToLark(messageId, `Nội dung file ${fileName}:\n${extractedText.slice(0, 1000)}${extractedText.length > 1000 ? '...' : ''}`);
          }
        } catch (err) {
          console.error('[File Processing Error]', err?.response?.data || err.message);
          await replyToLark(messageId, 'Lỗi khi xử lý file.');
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
                if (resourceResp.data.data.file_list && resourceResp.data.data.file_list.length > 0) {
                  const fileUrl = resourceResp.data.data.file_list[0].download_url;
                  const imageData = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                  extractedText = await extractImageContent(Buffer.from(imageData.data));
                }
              } catch (resourceError) {
                console.error('[Post] Lỗi khi lấy tài nguyên:', resourceError?.response?.data?.msg || resourceError.message);
              }
            }
          }

          const combinedMessage = textContent + (extractedText ? `\nNội dung từ hình ảnh: ${extractedText}` : '');
          if (!combinedMessage) {
            await replyToLark(messageId, 'Không trích xuất được nội dung.');
            return;
          }

          updateConversationMemory(chatId, 'user', combinedMessage);
          const memory = conversationMemory.get(chatId) || [];
          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528:free',
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
      } else if (messageType === 'text' && userMessage.trim()) {
        try {
          updateConversationMemory(chatId, 'user', userMessage);
          const memory = conversationMemory.get(chatId) || [];
          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528:free',
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
      } else {
        await replyToLark(messageId, 'Vui lòng sử dụng lệnh Base PRO, Base FIN, Report PRO, Report SALE hoặc Report FIN kèm câu hỏi.');
      }
    }
  } catch (e) {
    console.error('[Webhook Handler Error]', e.message);
    res.status(500).send('Lỗi máy chủ nội bộ');
  }
});

app.listen(port, () => {
  console.log(`Máy chủ đang chạy trên cổng ${port}`);
});
