const express = require('express');
const { EventDispatcher, createLarkClient } = require('@larksuiteoapi/node-sdk');
const multer = require('multer');
const fs = require('fs');
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const xlsx = require('xlsx');
const axios = require('axios');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const client = createLarkClient({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
});

const dispatcher = new EventDispatcher({
  encryptKey: process.env.LARK_ENCRYPT_KEY,
  verificationToken: process.env.LARK_VERIFICATION_TOKEN,
});

app.use(express.json());
app.use(dispatcher.express());

const upload = multer({ dest: 'uploads/' });
app.use('/uploads', express.static('uploads'));

const memory = {};

function updateConversationMemory(chatId, role, content) {
  if (!memory[chatId]) memory[chatId] = [];
  memory[chatId].push({ role, content });

  // Chỉ giữ tối đa 20 tin gần nhất
  if (memory[chatId].length > 20) {
    memory[chatId] = memory[chatId].slice(-20);
  }

  // Đặt hẹn xóa bộ nhớ sau 2 tiếng
  if (!memory[chatId].timeout) {
    memory[chatId].timeout = setTimeout(() => {
      delete memory[chatId];
    }, 2 * 60 * 60 * 1000);
  }
}

async function replyToLark(messageId, text) {
  await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
}

async function getUserMessageText(event) {
  if (event.message.message_type === 'text') {
    return JSON.parse(event.message.content).text;
  }
  return '[Non-text message]';
}

dispatcher.register({
  'im.message.receive_v1': async (data) => {
    const event = data.event;
    const chatId = event.message.chat_id;
    const messageId = event.message.message_id;
    const senderId = event.sender.sender_id?.user_id || chatId;
    const userMessage = await getUserMessageText(event);
    const memoryKey = chatId.startsWith('oc_') ? chatId : senderId;

    // Nếu người dùng vừa gửi file và nhắn "đọc file vừa gửi"
    if (/đọc file vừa gửi/i.test(userMessage)) {
      const files = fs.readdirSync('./uploads');
      const recentFile = files
        .map(f => ({ name: f, time: fs.statSync('./uploads/' + f).mtime }))
        .sort((a, b) => b.time - a.time)[0];

      if (!recentFile) {
        return await replyToLark(messageId, 'Không tìm thấy file nào gần đây.');
      }

      const filePath = './uploads/' + recentFile.name;
      const ext = path.extname(filePath).toLowerCase();
      let extractedText = '';

      try {
        if (ext === '.pdf') {
          const buffer = fs.readFileSync(filePath);
          const data = await pdfParse(buffer);
          extractedText = data.text;
        } else if (ext === '.docx') {
          const result = await mammoth.extractRawText({ path: filePath });
          extractedText = result.value;
        } else if (ext === '.xlsx') {
          const workbook = xlsx.readFile(filePath);
          const sheetNames = workbook.SheetNames;
          extractedText = sheetNames.map(name => {
            const sheet = workbook.Sheets[name];
            return `Sheet: ${name}\n` + xlsx.utils.sheet_to_csv(sheet);
          }).join('\n\n');
        } else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
          const result = await Tesseract.recognize(filePath, 'eng');
          extractedText = result.data.text;
        } else {
          return await replyToLark(messageId, 'Không hỗ trợ định dạng file này.');
        }
      } catch (err) {
        return await replyToLark(messageId, 'Lỗi khi đọc file: ' + err.message);
      }

      updateConversationMemory(memoryKey, 'user', extractedText);

      const chatResponse = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
          messages: [
            { role: 'system', content: 'Bạn là trợ lý AI, giúp phân tích nội dung văn bản người dùng cung cấp.' },
            { role: 'user', content: `Hãy phân tích nội dung sau:\n\n${extractedText}` },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const reply = chatResponse.data.choices[0].message.content;
      updateConversationMemory(memoryKey, 'assistant', reply);
      return await replyToLark(messageId, reply);
    }

    // Nếu chứa URL đến Base hoặc ID Base
    if (/\/base\/[a-zA-Z0-9]+/.test(userMessage) || /base_[a-zA-Z0-9]+/.test(userMessage)) {
      try {
        const allBases = await client.bitable.appTable.list({
          params: { page_size: 50 },
        });

        let baseSummary = '';

        for (const base of allBases?.data?.items || []) {
          const baseId = base.app_token;
          const tablesRes = await client.bitable.appTable.list({ path: { app_token: baseId } });
          const tables = tablesRes?.data?.items || [];

          for (const table of tables) {
            const tableId = table.table_id;
            const recordsRes = await client.bitable.appTableRecord.list({
              path: { app_token: baseId, table_id: tableId },
              params: { page_size: 100 },
            });

            const records = recordsRes?.data?.items || [];
            baseSummary += `\n\n📊 Bảng: ${table.name}\n`;
            for (const record of records) {
              const row = Object.entries(record.fields || {})
                .map(([key, val]) => `${key}: ${val}`)
                .join(' | ');
              baseSummary += row + '\n';
            }
          }
        }

        updateConversationMemory(memoryKey, 'user', userMessage);

        const now = new Date(); now.setHours(now.getHours() + 7);
        const nowVN = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

        const chatResponse = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
            messages: [
              { role: 'system', content: `Bạn là trợ lý AI, giúp phân tích dữ liệu doanh nghiệp. Giờ Việt Nam hiện tại là: ${nowVN}` },
              { role: 'user', content: `Hãy phân tích và tóm tắt dữ liệu bảng sau:\n\n${baseSummary}` },
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );

        const reply = chatResponse.data.choices[0].message.content;
        updateConversationMemory(memoryKey, 'assistant', reply);
        return await replyToLark(messageId, reply);
      } catch (err) {
        return await replyToLark(messageId, 'Lỗi khi truy xuất dữ liệu Base: ' + err.message);
      }
    }

    // Chat thông thường
    updateConversationMemory(memoryKey, 'user', userMessage);

    const now = new Date(); now.setHours(now.getHours() + 7);
    const nowVN = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

    const chatResponse = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
        messages: [
          { role: 'system', content: `Bạn là trợ lý AI hỗ trợ trò chuyện tiếng Việt. Giờ hiện tại (VN): ${nowVN}` },
          ...memory[memoryKey],
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const reply = chatResponse.data.choices[0].message.content;
    updateConversationMemory(memoryKey, 'assistant', reply);
    await replyToLark(messageId, reply);
  },
});

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded');
  res.send({ path: '/uploads/' + req.file.filename });
});

app.get('/', (req, res) => {
  res.send('Lark bot is running');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
