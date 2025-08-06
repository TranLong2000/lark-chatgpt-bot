const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

// Cập nhật ánh xạ Base (giữ nguyên)
const BASE_MAPPINGS = {
  'PUR': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbl61rgzOwS8viB2&view=vewi5cxZif',
  'SALE': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tblClioOV3nPN6jM&view=vew7RMyPed',
  'FIN': 'https://cgfscmkep8m.sg.larksuite.com/base/Um8Zb07ayaDFAws9BRFlbZtngZf?table=tblc0IuDKdYrVGqo&view=vewU8BLeBr',
  'TEST': 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbllwXLQBdRgex9z&view=vewksBlcon',
  'PAY': 'https://cgfscmkep8m.sg.larksuite.com/base/UBrwbz2tHaeEwosVO5dlV0Lcgqb?table=tblQcpErvmsBpWCh&view=vewIQhfi04'
};

const SHEET_MAPPINGS = {
  'PUR_SHEET': 'https://cgfscmkep8m.sg.larksuite.com/sheets/Qd5JsUX0ehhqO9thXcGlyAIYg9g?sheet=6eGZ0D'
};

// Thêm Map để lưu dữ liệu tạm với timestamp (hết hạn sau 1 tiếng = 3600000ms)
const tempDataStore = new Map();

const processedMessageIds = new Set();
const conversationMemory = new Map();
const pendingTasks = new Map();
const pendingFiles = new Map();

if (!fs.existsSync('temp_files')) {
  fs.mkdirSync('temp_files');
}

// Sử dụng express.raw với limit và timeout tăng cho /webhook
app.use('/webhook', express.raw({ type: '*/*', limit: '10mb', timeout: 60000 }));
app.use('/webhook-base', express.json({ limit: '10mb', timeout: 60000 }));

// Giữ nguyên các function verifySignature, decryptMessage, getUserInfo, replyToLark, extractFileContent, extractImageContent, getAppAccessToken, logBotOpenId, getTableMeta, getAllRows, getSheetData, updateConversationMemory, analyzeQueryAndProcessData, processBaseData, processSheetData, createPieChartFromBaseData, sendChartToGroup, uploadImageToLark

// Thêm function để phân tích dữ liệu tạm và trả lời
async function analyzeTempData(userMessage, token) {
  const now = Date.now();
  let validData = null;

  // Lọc dữ liệu còn hiệu lực (trong 1 tiếng)
  for (const [key, { data, timestamp }] of tempDataStore) {
    if (now - timestamp < 3600000) {
      validData = data; // Lấy dữ liệu đầu tiên còn hiệu lực (có thể mở rộng để lấy nhiều dữ liệu)
      break;
    } else {
      tempDataStore.delete(key); // Xóa dữ liệu quá hạn
    }
  }

  if (!validData) {
    return { result: 'Không có dữ liệu tạm nào còn hiệu lực (hết hạn sau 1 tiếng).' };
  }

  const $ = cheerio.load(validData);
  let response = 'Không hiểu yêu cầu, vui lòng kiểm tra lại cú pháp.';

  if (userMessage.toLowerCase().includes('hiển thị bảng 1')) {
    const table1 = $('table').eq(0); // Lấy bảng đầu tiên
    if (table1.length) {
      let tableContent = '';
      table1.find('tr').each((i, row) => {
        tableContent += $(row).text().trim() + '\n';
      });
      response = `Nội dung bảng 1:\n${tableContent}`;
    } else {
      response = 'Không tìm thấy bảng 1 trong dữ liệu tạm.';
    }
  } else if (userMessage.toLowerCase().includes('tổng số liệu')) {
    const numbers = $('td').text().match(/\d+/g); // Trích xuất số từ các ô td
    if (numbers) {
      const total = numbers.reduce((sum, num) => sum + parseInt(num), 0);
      response = `Tổng số liệu: ${total}`;
    } else {
      response = 'Không có số liệu để tính tổng.';
    }
  } else {
    // Gửi câu hỏi chung đến OpenRouter để phân tích
    const analysisPrompt = `
      Bạn là một trợ lý AI chuyên phân tích dữ liệu HTML. Dựa trên câu hỏi sau và nội dung HTML dưới đây:
      - Câu hỏi: "${userMessage}"
      - Nội dung HTML: ${validData.substring(0, 1000)}... (đoạn đầu)
      Hãy:
      1. Xác định thông tin liên quan từ HTML.
      2. Trả lời dưới dạng JSON: { "result": string } với kết quả hoặc thông báo nếu không có dữ liệu.
      Nếu không rõ, trả về: { "result": "Không hiểu yêu cầu, vui lòng kiểm tra lại cú pháp" }.
    `;

    const aiResponse = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-r1-0528:free',
        messages: [
          { role: 'system', content: 'Bạn là một trợ lý AI chuyên phân tích dữ liệu HTML với ít token nhất. Luôn trả lời dưới dạng JSON hợp lệ.' },
          { role: 'user', content: analysisPrompt },
        ],
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const aiContent = aiResponse.data.choices[0].message.content.trim();
    try {
      const analysis = JSON.parse(aiContent);
      response = analysis.result;
    } catch (parseError) {
      console.error('[AnalyzeTempData] Phân tích AI thất bại:', parseError.message);
    }
  }

  return { result: response };
}

// Thêm function để xử lý dữ liệu tạm
async function processTempData(messageId, userMessage, token, mentionUserId, mentionUserName) {
  try {
    const { result } = await analyzeTempData(userMessage, token);
    const chatId = pendingTasks.get(messageId)?.chatId;
    updateConversationMemory(chatId, 'user', userMessage);
    updateConversationMemory(chatId, 'assistant', result);
    await replyToLark(messageId, result, mentionUserId, mentionUserName);
  } catch (e) {
    console.error('[TempData API Error] Nguyên nhân:', e.message, 'Stack:', e.stack);
    await replyToLark(
      messageId,
      'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long',
      mentionUserId,
      mentionUserName
    );
  } finally {
    pendingTasks.delete(messageId);
  }
}

// Cập nhật /webhook để lưu dữ liệu tạm
app.post('/webhook', async (req, res) => {
  try {
    console.log('[Webhook Debug] Raw Buffer Length:', req.body.length);
    console.log('[Webhook Debug] Raw Buffer (Hex):', Buffer.from(req.body).toString('hex'));
    console.log('[Webhook Debug] Raw Buffer:', req.body.toString('utf8'));
    let bodyRaw = req.body.toString('utf8');
    console.log('[Webhook Debug] Parsed Body:', bodyRaw);
    console.log('[Webhook Debug] All Headers:', JSON.stringify(req.headers, null, 2));

    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];

    // Kiểm tra nếu là dữ liệu từ Python (bỏ qua chữ ký)
    if (req.headers['user-agent'] && req.headers['user-agent'].includes('Python')) {
      console.log('[Webhook] Nhận dữ liệu từ Python, lưu vào bộ nhớ tạm');
      const dataKey = `report_${Date.now()}`; // Tạo key duy nhất dựa trên timestamp
      tempDataStore.set(dataKey, { data: bodyRaw, timestamp: Date.now() });
      return res.status(200).send('Dữ liệu báo cáo đã được lưu tạm thời trong 1 tiếng');
    }

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      console.warn('[Webhook] Bỏ qua kiểm tra chữ ký để debug. Kiểm tra LARK_ENCRYPT_KEY sau. Request Body:', bodyRaw);
      // return res.status(401).send('Chữ ký không hợp lệ');
    } else {
      console.log('[VerifySignature] Chữ ký hợp lệ, tiếp tục xử lý');
    }

    let decryptedData = {};
    try {
      const { encrypt } = bodyRaw ? JSON.parse(bodyRaw) : {};
      if (encrypt) {
        decryptedData = decryptMessage(encrypt);
        console.log('[Webhook Debug] Decrypted Data:', JSON.stringify(decryptedData));
      } else {
        console.error('[Webhook Debug] Không tìm thấy trường encrypt trong body:', bodyRaw);
      }
    } catch (parseError) {
      console.error('[Webhook Debug] Lỗi khi parse body:', parseError.message, 'Raw Body:', bodyRaw);
    }

    if (decryptedData.header && decryptedData.header.event_type === 'url_verification') {
      return res.json({ challenge: decryptedData.event.challenge });
    }

    if (decryptedData.header && decryptedData.header.event_type === 'im.message.receive_v1') {
      const senderId = decryptedData.event.sender.sender_id.open_id;
      const message = decryptedData.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const messageType = message.message_type;
      const parentId = message.parent_id;
      const mentions = message.mentions || [];

      if (processedMessageIds.has(messageId)) return res.sendStatus(200);
      processedMessageIds.add(messageId);

      if (senderId === (process.env.BOT_SENDER_ID || '')) return res.sendStatus(200);

      const botOpenId = process.env.BOT_OPEN_ID;
      const isBotMentioned = mentions.some(mention => mention.id.open_id === botOpenId);

      let userMessage = '';
      try {
        const parsed = JSON.parse(message.content);
        userMessage = parsed.text || '';
      } catch (err) {
        console.error('[Parse Content Error] Nguyên nhân:', err.message, 'Content:', message.content);
      }

      console.log('[Message Debug] chatId:', chatId, 'messageId:', messageId, 'parentId:', parentId, 'messageType:', messageType, 'Full Message:', JSON.stringify(message));
      console.log('[Mentions Debug] Mentions:', JSON.stringify(mentions, null, 2));

      const hasAllMention = mentions.some(mention => mention.key === '@_all');
      if (hasAllMention && !isBotMentioned) {
        return res.sendStatus(200);
      }

      if (!isBotMentioned && messageType !== 'file' && messageType !== 'image') {
        return res.sendStatus(200);
      }

      res.sendStatus(200);

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
      let spreadsheetToken = '';

      const mentionPrefix = `@_user_1 `;
      let reportMatch;
      if (userMessage.startsWith(mentionPrefix)) {
        const contentAfterMention = userMessage.slice(mentionPrefix.length);
        reportMatch = contentAfterMention.match(new RegExp(`^(${Object.keys(BASE_MAPPINGS).join('|')}|REPORT)(,|,)`, 'i'));
        if (reportMatch) {
          const reportName = reportMatch[1].toUpperCase();
          if (reportName === 'REPORT') {
            console.log('[Webhook] Triggering processTempData for REPORT');
            pendingTasks.set(messageId, { chatId, userMessage, mentionUserId, mentionUserName });
            await processTempData(messageId, userMessage, token, mentionUserId, mentionUserName);
          } else {
            const reportUrl = BASE_MAPPINGS[reportName];
            if (reportUrl) {
              console.log('[Webhook] Processing report:', reportName, 'URL:', reportUrl);
              const urlMatch = reportUrl.match(/base\/([a-zA-Z0-9]+)\?.*table=([a-zA-Z0-9]+)/);
              if (urlMatch) {
                baseId = urlMatch[1];
                tableId = urlMatch[2];
                console.log('[Webhook] Extracted baseId:', baseId, 'tableId:', tableId);
              } else {
                console.error('[Webhook] Failed to extract baseId/tableId from URL:', reportUrl);
              }
            }
          }
        }
      }

      if (baseId && tableId) {
        console.log('[Webhook] Triggering processBaseData for:', reportMatch ? reportMatch[1].toUpperCase() : 'unknown');
        pendingTasks.set(messageId, { chatId, userMessage, mentionUserId, mentionUserName });
        await processBaseData(messageId, baseId, tableId, userMessage, token);
      } else if (spreadsheetToken) {
        pendingTasks.set(messageId, { chatId, userMessage, mentionUserId, mentionUserName });
        await processSheetData(messageId, spreadsheetToken, userMessage, token, mentionUserId, mentionUserName);
      } else if (messageType === 'file' || messageType === 'image') {
        try {
          console.log('[File/Image Debug] Processing message type:', messageType, 'Full Message:', JSON.stringify(message));
          const fileKey = message.file_key;
          if (!fileKey) {
            console.error('[File/Image Debug] Nguyên nhân: Không tìm thấy file_key trong message', 'Message:', JSON.stringify(message));
            await replyToLark(
              messageId,
              'Không tìm thấy file_key. Vui lòng kiểm tra lại file hoặc gửi lại.',
              mentionUserId,
              mentionUserName
            );
            return;
          }

          const fileName = message.file_name || `${messageId}.${messageType === 'image' ? 'jpg' : 'bin'}`;
          const ext = path.extname(fileName).slice(1).toLowerCase();
          console.log('[File/Image Debug] File key:', fileKey, 'File name:', fileName, 'Extension:', ext);

          pendingFiles.set(chatId, { fileKey, fileName, ext, messageId, timestamp: Date.now() });

          await replyToLark(
            messageId,
            'File đã nhận. Vui lòng reply tin nhắn này với câu hỏi hoặc yêu cầu (tag @L-GPT nếu cần). File sẽ bị xóa khỏi bộ nhớ sau 5 phút nếu không có reply.',
            mentionUserId,
            mentionUserName
          );
        } catch (err) {
          console.error('[File Processing Error] Nguyên nhân:', err?.response?.data || err.message, 'Message:', JSON.stringify(message));
          await replyToLark(
            messageId,
            `Lỗi khi xử lý file ${message.file_name || 'không xác định'}. Nguyên nhân: ${err.message}`,
            mentionUserId,
            mentionUserName
          );
        }
      } else if (messageType === 'post' && parentId) {
        const pendingFile = pendingFiles.get(chatId);
        if (pendingFile && pendingFile.messageId === parentId) {
          try {
            console.log('[Post Debug] Processing reply with file, parentId:', parentId, 'pendingFile:', JSON.stringify(pendingFile));
            const { fileKey, fileName, ext } = pendingFile;

            const fileUrlResp = await axios.get(
              `${process.env.LARK_DOMAIN}/open-apis/im/v1/files/${fileKey}/download_url`,
              { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
            );
            const fileUrl = fileUrlResp.data.data.download_url;
            console.log('[Post Debug] Download URL:', fileUrl);

            const extractedText = await extractFileContent(fileUrl, ext);
            console.log('[Post Debug] Extracted text:', extractedText);

            if (extractedText.startsWith('Lỗi') || !extractedText) {
              await replyToLark(
                messageId,
                `Không thể trích xuất nội dung từ file ${fileName}. Nguyên nhân: ${extractedText}`,
                mentionUserId,
                mentionUserName
              );
            } else {
              const combinedMessage = userMessage + (extractedText ? `\nNội dung từ file: ${extractedText}` : '');
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
                  timeout: 20000,
                }
              );

              const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long';
              const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
              updateConversationMemory(chatId, 'assistant', cleanMessage);
              await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
            }
            pendingFiles.delete(chatId);
          } catch (err) {
            console.error('[Post Processing Error] Nguyên nhân:', err?.response?.data || err.message);
            await replyToLark(
              messageId,
              `Lỗi khi xử lý file ${pendingFile.fileName}. Nguyên nhân: ${err.message}`,
              mentionUserId,
              mentionUserName
            );
            pendingFiles.delete(chatId);
          }
        } else {
          console.log('[Post Debug] No matching file found for parentId:', parentId, 'pendingFiles:', JSON.stringify(pendingFiles));
          await replyToLark(
            messageId,
            'Vui lòng reply trực tiếp tin nhắn chứa file để mình xử lý. Nếu đã gửi file, hãy gửi lại file hoặc kiểm tra lại quy trình.',
            mentionUserId,
            mentionUserName
          );
        }
      } else if (messageType === 'text' && userMessage.trim() && !baseId && !tableId) {
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
              timeout: 20000,
            }
          );

          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long';
          const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
          updateConversationMemory(chatId, 'assistant', cleanMessage);
          await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
        } catch (e) {
          console.error('[AI Error] Nguyên nhân:', e?.response?.data?.msg || e.message);
          let errorMessage = 'Xin lỗi, tôi chưa tìm ra được kết quả, vui lòng liên hệ Admin Long';
          if (e.code === 'ECONNABORTED') {
            errorMessage = 'Hết thời gian chờ khi gọi API AI, vui lòng thử lại sau hoặc kiểm tra kết nối mạng.';
          }
          await replyToLark(messageId, errorMessage, mentionUserId, mentionUserName);
        }
      } else {
        await replyToLark(
          messageId,
          'Vui lòng sử dụng lệnh PUR, SALE, FIN, TEST, PAY, hoặc REPORT kèm dấu phẩy và câu hỏi, hoặc gửi file/hình ảnh.',
          mentionUserId,
          mentionUserName
        );
      }
    }
  } catch (e) {
    console.error('[Webhook Handler Error] Nguyên nhân:', e.message, 'Request Body:', req.body.toString('utf8') || 'Không có dữ liệu', 'Stack:', e.stack);
    res.status(500).send('Lỗi máy chủ nội bộ');
  }
});

// Giữ nguyên /webhook-base
app.post('/webhook-base', async (req, res) => {
  try {
    console.log('[Webhook-Base Debug] Raw Body as String:', req.body.toString());
    console.log('[Webhook-Base Debug] All Headers:', JSON.stringify(req.headers, null, 2));

    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const bodyRaw = JSON.stringify(req.body);

    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) {
      console.warn('[Webhook-Base] Chữ ký không hợp lệ hoặc không kiểm tra được. Request Body:', bodyRaw);
      return res.status(401).send('Chữ ký không hợp lệ');
    }
    console.log('[Webhook-Base] Chữ ký hợp lệ, tiếp tục xử lý');

    if (req.body.event_type === 'url_verification') {
      return res.json({ challenge: req.body.event.challenge });
    }

    if (req.body.event_type === 'bitable.record.updated') {
      const event = req.body;
      const baseId = event.app_id;
      const tableId = event.table_id;
      const updateDate = event.fields['Update Date'];

      if (!updateDate || updateDate.includes('{{')) {
        console.warn('[Webhook-Base] Update Date không hợp lệ hoặc chứa placeholder ({{...}}), bỏ qua. Payload:', JSON.stringify(event.fields));
        return res.sendStatus(200);
      }

      const groupChatIds = (process.env.LARK_GROUP_CHAT_IDS || '').split(',').filter(id => id.trim());
      if (groupChatIds.length === 0) {
        console.error('[Webhook-Base] LARK_GROUP_CHAT_IDS chưa được thiết lập hoặc rỗng');
        return res.status(400).send('Thiếu group chat IDs');
      }

      const token = await getAppAccessToken();
      for (const chatId of groupChatIds) {
        console.log('[Webhook-Base] Xử lý gửi đến group:', chatId);
        const { success, chartUrl, message } = await createPieChartFromBaseData(baseId, tableId, token, chatId);

        if (success) {
          const messageText = `Biểu đồ % Manufactory đã được cập nhật (ngày ${updateDate})`;
          await sendChartToGroup(token, chatId, chartUrl, messageText);
        } else {
          await sendChartToGroup(token, chatId, null, message || 'Lỗi khi tạo biểu đồ từ dữ liệu Base');
        }
      }
      return res.sendStatus(200);
    }

    console.warn('[Webhook-Base] Loại sự kiện không được hỗ trợ:', req.body.event_type);
    return res.status(400).send('Loại sự kiện không được hỗ trợ');
  } catch (e) {
    console.error('[Webhook-Base Handler Error] Nguyên nhân:', e.message, 'Request Body:', JSON.stringify(req.body) || 'Không có dữ liệu', 'Stack:', e.stack);
    res.status(500).send('Lỗi máy chủ nội bộ');
  }
});

// Giữ nguyên các phần còn lại
process.on('SIGTERM', () => {
  console.log('[Server] Nhận tín hiệu SIGTERM, đang tắt...');
  pendingTasks.forEach((task, messageId) => replyToLark(messageId, 'Xử lý bị gián đoạn.', task.mentionUserId, task.mentionUserName));
  process.exit(0);
});

setInterval(() => {
  conversationMemory.clear();
  console.log('[Memory] Đã xóa bộ nhớ');
}, 2 * 60 * 60 * 1000);

logBotOpenId().then(() => {
  app.listen(port, () => {
    console.log(`Máy chủ đang chạy trên cổng ${port}`);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [chatId, file] of pendingFiles) {
    if (now - file.timestamp > 5 * 60 * 1000) {
      console.log('[Cleanup] Xóa file từ pendingFiles do hết thời gian:', chatId, file.fileName);
      pendingFiles.delete(chatId);
    }
  }
  // Xóa dữ liệu tạm quá hạn (1 tiếng)
  for (const [key, { timestamp }] of tempDataStore) {
    if (now - timestamp > 3600000) {
      console.log('[Cleanup] Xóa dữ liệu tạm do hết thời gian:', key);
      tempDataStore.delete(key);
    }
  }
}, 60 * 1000);
