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

async function getUserInfo(openId, token) {
  try {
    const response = await axios.get(`${process.env.LARK_DOMAIN}/open-apis/contact/v3/users/${openId}?user_id_type=open_id`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    const user = response.data.data.user;
    return user.name || `User_${openId.slice(-4)}`;
  } catch (err) {
    return `User_${openId.slice(-4)}`;
  }
}

async function replyToLark(messageId, content, mentionUserId = null, mentionUserName = null) {
  try {
    const tokenResp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`, {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    });
    const token = tokenResp.data.app_access_token;

    let messageContent;
    let msgType = 'text';
    if (mentionUserId && mentionUserName && mentionUserId !== process.env.BOT_OPEN_ID) {
      console.log('[Reply Debug] Tagging user:', mentionUserId, mentionUserName);
      messageContent = {
        text: `${content} <at user_id="${mentionUserId}">${mentionUserName}</at>`,
      };
    } else {
      messageContent = { text: content };
    }

    const response = await axios.post(
      `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages/${messageId}/reply`,
      {
        msg_type: msgType,
        content: JSON.stringify(messageContent),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('[Reply Success] Response:', response.data);
  } catch (err) {
    console.error('[Reply Error]', err?.response?.data || err.message);
  }
}

async function extractFileContent(fileUrl, fileType) {
  try {
    console.log('[ExtractFileContent] Đang tải file:', fileUrl, 'với type:', fileType);
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 10000 });
    const buffer = Buffer.from(response.data);

    if (fileType === 'pdf') {
      console.log('[ExtractFileContent] Đang xử lý PDF...');
      const data = await pdfParse(buffer);
      return data.text.trim();
    }

    if (fileType === 'docx') {
      console.log('[ExtractFileContent] Đang xử lý DOCX...');
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim();
    }

    if (fileType === 'xlsx') {
      console.log('[ExtractFileContent] Đang xử lý XLSX...');
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
      return sheet.map(row => row.join(', ')).join('; ');
    }

    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileType)) {
      console.log('[ExtractFileContent] Đang thực hiện OCR cho hình ảnh...');
      const result = await Tesseract.recognize(buffer, 'eng+vie', { logger: m => console.log('[Tesseract]', m) });
      return result.data.text.trim();
    }

    console.log('[ExtractFileContent] Không hỗ trợ loại file:', fileType);
    return 'Không hỗ trợ loại file này.';
  } catch (err) {
    console.error('[ExtractFileContent Error] Nguyên nhân:', err.message, 'URL:', fileUrl, 'Type:', fileType);
    return `Lỗi khi trích xuất nội dung file: ${err.message}`;
  }
}

async function extractImageContent(imageData) {
  try {
    console.log('[ExtractImageContent] Đang thực hiện OCR...');
    const result = await Tesseract.recognize(imageData, 'eng+vie', { logger: m => console.log('[Tesseract]', m) });
    return result.data.text.trim();
  } catch (err) {
    console.error('[ExtractImageContent Error] Nguyên nhân:', err.message);
    return `Lỗi khi trích xuất nội dung hình ảnh: ${err.message}`;
  }
}

async function getAppAccessToken() {
  const resp = await axios.post(`${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`, {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  return resp.data.app_access_token;
}

async function logBotOpenId() {
  try {
    const token = await getAppAccessToken();
    const response = await axios.get(`${process.env.LARK_DOMAIN}/open-apis/bot/v3/info`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    const botOpenId = response.data.bot.open_id;
    console.log('[Bot Info] BOT_OPEN_ID:', botOpenId);
    return botOpenId;
  } catch (err) {
    console.error('[LogBotOpenId Error]', err?.response?.data || err.message);
    return null;
  }
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
        timeout: 15000,
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
      await replyToLark(
        messageId,
        'Không có dữ liệu từ bảng.',
        pendingTasks.get(messageId)?.mentionUserId,
        pendingTasks.get(messageId)?.mentionUserName
      );
      return;
    }

    const validRows = allRows.filter(row => row && typeof row === 'object');
    if (validRows.length === 0) {
      await replyToLark(
        messageId,
        'Không có dòng dữ liệu hợp lệ.',
        pendingTasks.get(messageId)?.mentionUserId,
        pendingTasks.get(messageId)?.mentionUserName
      );
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
        timeout: 15000,
      }
    );

    const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, không có câu trả lời.';
    const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
    updateConversationMemory(chatId, 'user', userMessage);
    updateConversationMemory(chatId, 'assistant', cleanMessage);
    await replyToLark(
      messageId,
      cleanMessage,
      pendingTasks.get(messageId)?.mentionUserId,
      pendingTasks.get(messageId)?.mentionUserName
    );
  } catch (e) {
    console.error('[Base API Error]', e?.response?.data || e.message);
    let errorMessage = '❌ Lỗi khi xử lý, vui lòng thử lại sau.';
    if (e.code === 'ECONNABORTED') {
      errorMessage = '❌ Hết thời gian chờ khi gọi API, vui lòng thử lại sau hoặc kiểm tra kết nối mạng.';
    }
    await replyToLark(
      messageId,
      errorMessage,
      pendingTasks.get(messageId)?.mentionUserId,
      pendingTasks.get(messageId)?.mentionUserName
    );
  } finally {
    pendingTasks.delete(messageId);
  }
}

// Xử lý tín hiệu dừng
process.on('SIGTERM', () => {
  console.log('[Server] Nhận tín hiệu SIGTERM, đang tắt...');
  pendingTasks.forEach((task, messageId) => replyToLark(messageId, 'Xử lý bị gián đoạn.', task.mentionUserId, task.mentionUserName));
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
      const mentions = message.mentions || [];

      if (processedMessageIds.has(messageId)) return res.send({ code: 0 });
      processedMessageIds.add(messageId);

      if (senderId === (process.env.BOT_SENDER_ID || '')) return res.json({ code: 0 });

      const botOpenId = process.env.BOT_OPEN_ID;
      const isBotMentioned = mentions.some(mention => mention.id.open_id === botOpenId);

      let userMessage = '';
      try {
        const parsed = JSON.parse(message.content);
        userMessage = parsed.text || '';
      } catch (err) {
        console.error('[Parse Content Error] Nguyên nhân:', err.message);
      }

      console.log('[Mentions Debug]', JSON.stringify(mentions, null, 2));

      const hasAllMention = mentions.some(mention => mention.key === '@_all');
      if (hasAllMention && !isBotMentioned) {
        return res.json({ code: 0 });
      }

      if (!isBotMentioned) {
        return res.json({ code: 0 });
      }

      res.json({ code: 0 });

      const token = await getAppAccessToken();

      let mentionUserId = senderId;
      let mentionUserName = await getUserInfo(senderId, token);
      console.log('[Sender Debug] senderId:', senderId, 'senderName:', mentionUserName);

      if (mentions.length > 0) {
        const userMention = mentions.find(mention => mention.id.open_id !== botOpenId && mention.id.open_id !== senderId);
        if (userMention) {
          mentionUserId = userMention.id.open_id;
          mentionUserName = await getUserInfo(mentionUserId, token);
          console.log('[User Debug] mentionUserId:', mentionUserId, 'mentionUserName:', mentionUserName);
        }
      }

      let baseId = '';
      let tableId = '';
      let commandType = '';

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
        pendingTasks.set(messageId, { chatId, userMessage, mentionUserId, mentionUserName });
        await processBaseData(messageId, baseId, tableId, userMessage, token);
      } else if (messageType === 'file' || messageType === 'image') {
        try {
          console.log('[File/Image Debug] Processing message type:', messageType);
          const fileKey = message.file_key;
          if (!fileKey) {
            console.error('[File/Image Debug] Nguyên nhân: Không tìm thấy file_key trong message');
            await replyToLark(
              messageId,
              'Không tìm thấy file_key. Vui lòng gửi lại file.',
              mentionUserId,
              mentionUserName
            );
            return;
          }

          const fileName = message.file_name || `${messageId}.${messageType === 'image' ? 'jpg' : 'bin'}`;
          const ext = path.extname(fileName).slice(1).toLowerCase();
          console.log('[File/Image Debug] File key:', fileKey, 'File name:', fileName, 'Extension:', ext);

          const fileUrlResp = await axios.get(
            `${process.env.LARK_DOMAIN}/open-apis/im/v1/files/${fileKey}/download_url`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
          );
          const fileUrl = fileUrlResp.data.data.download_url;
          console.log('[File/Image Debug] Download URL:', fileUrl);

          const extractedText = await extractFileContent(fileUrl, ext);
          console.log('[File/Image Debug] Extracted text:', extractedText);

          if (extractedText.startsWith('Lỗi') || !extractedText) {
            await replyToLark(
              messageId,
              `Không thể trích xuất nội dung từ file ${fileName}. Nguyên nhân: ${extractedText}`,
              mentionUserId,
              mentionUserName
            );
          } else {
            updateConversationMemory(chatId, 'user', `File ${fileName}: nội dung trích xuất`);
            await replyToLark(
              messageId,
              `Nội dung file ${fileName}:\n${extractedText.slice(0, 1000)}${extractedText.length > 1000 ? '...' : ''}`,
              mentionUserId,
              mentionUserName
            );
          }
        } catch (err) {
          console.error('[File Processing Error] Nguyên nhân:', err?.response?.data || err.message);
          await replyToLark(
            messageId,
            `Lỗi khi xử lý file ${message.file_name || 'không xác định'}. Nguyên nhân: ${err.message}`,
            mentionUserId,
            mentionUserName
          );
        }
      } else if (messageType === 'post') {
        try {
          console.log('[Post Debug] Processing post message');
          const parsedContent = JSON.parse(message.content);
          let textContent = '';
          let imageKey = '';
          let fileKey = message.file_key;

          for (const block of parsedContent.content) {
            for (const item of block) {
              if (item.tag === 'text') textContent += item.text + ' ';
              else if (item.tag === 'img') imageKey = item.image_key;
            }
          }
          textContent = textContent.trim();
          console.log('[Post Debug] Text content:', textContent, 'Image key:', imageKey, 'File key:', fileKey);

          let extractedText = '';
          if (imageKey && !fileKey) {
            console.log('[Post Debug] Attempting to fetch image with key:', imageKey);
            try {
              const imageUrl = `${process.env.LARK_DOMAIN}/open-apis/im/v1/images/${imageKey}`;
              const imageResp = await axios.get(imageUrl, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
                responseType: 'arraybuffer',
                timeout: 10000,
              });
              extractedText = await extractImageContent(Buffer.from(imageResp.data));
              console.log('[Post Debug] Extracted text from image:', extractedText);
            } catch (imageError) {
              console.error('[Post Debug] Nguyên nhân lỗi khi lấy hình ảnh:', imageError?.response?.data?.msg || imageError.message);
              await replyToLark(
                messageId,
                'Hình ảnh trong tin nhắn không thể tải. Vui lòng gửi hình ảnh trực tiếp (tải file) thay vì nhúng trong tin nhắn.',
                mentionUserId,
                mentionUserName
              );
              return;
            }
          } else if (fileKey) {
            console.log('[Post Debug] Using file_key:', fileKey);
            const fileUrlResp = await axios.get(
              `${process.env.LARK_DOMAIN}/open-apis/im/v1/files/${fileKey}/download_url`,
              { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
            );
            const fileUrl = fileUrlResp.data.data.download_url;
            extractedText = await extractFileContent(fileUrl, 'jpg');
            console.log('[Post Debug] Extracted text from file:', extractedText);
          }

          const combinedMessage = textContent + (extractedText ? `\nNội dung từ hình ảnh: ${extractedText}` : '');
          if (!combinedMessage.trim()) {
            console.log('[Post Debug] No content extracted from post.');
            await replyToLark(
              messageId,
              'Không trích xuất được nội dung. Vui lòng gửi hình ảnh trực tiếp hoặc dán URL.',
              mentionUserId,
              mentionUserName
            );
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
              timeout: 15000,
            }
          );

          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, không có câu trả lời.';
          const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
          updateConversationMemory(chatId, 'assistant', cleanMessage);
          await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
        } catch (e) {
          console.error('[Post Processing Error] Nguyên nhân:', e?.response?.data?.msg || e.message);
          await replyToLark(messageId, '❌ Lỗi khi xử lý post.', mentionUserId, mentionUserName);
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
              timeout: 15000,
            }
          );

          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, không có câu trả lời.';
          const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
          updateConversationMemory(chatId, 'assistant', cleanMessage);
          await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
        } catch (e) {
          console.error('[AI Error] Nguyên nhân:', e?.response?.data?.msg || e.message);
          let errorMessage = '❌ Lỗi khi gọi AI, vui lòng thử lại sau.';
          if (e.code === 'ECONNABORTED') {
            errorMessage = '❌ Hết thời gian chờ khi gọi API AI, vui lòng thử lại sau hoặc kiểm tra kết nối mạng.';
          }
          await replyToLark(messageId, errorMessage, mentionUserId, mentionUserName);
        }
      } else {
        await replyToLark(
          messageId,
          'Vui lòng sử dụng lệnh Base PRO, Base FIN, Report PRO, Report SALE hoặc Report FIN kèm câu hỏi, hoặc gửi file/hình ảnh.',
          mentionUserId,
          mentionUserName
        );
      }
    }
  } catch (e) {
    console.error('[Webhook Handler Error] Nguyên nhân:', e.message);
    res.status(500).send('Lỗi máy chủ nội bộ');
  }
});

// Gọi hàm logBotOpenId khi server khởi động
logBotOpenId().then(() => {
  app.listen(port, () => {
    console.log(`Máy chủ đang chạy trên cổng ${port}`);
  });
});
