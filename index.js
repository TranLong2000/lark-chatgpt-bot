const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const multer = require('multer');
const tesseract = require('tesseract.js');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const upload = multer({ dest: 'uploads/' });

const conversationMemory = new Map(); // Bộ nhớ theo chatId
const memoryTTL = 2 * 60 * 60 * 1000; // 2 tiếng

function updateConversationMemory(chatId, role, content) {
  const memory = conversationMemory.get(chatId) || [];
  memory.push({ role, content, time: Date.now() });
  conversationMemory.set(chatId, memory.filter(m => Date.now() - m.time < memoryTTL));
}

function clearMemory(chatId) {
  conversationMemory.delete(chatId);
}

async function replyToLark(messageId, text) {
  await axios.post('https://open.larksuite.com/open-apis/im/v1/messages/' + messageId + '/reply', {
    content: JSON.stringify({ text }),
    msg_type: 'text',
  }, {
    headers: {
      Authorization: `Bearer ${process.env.LARK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.type === 'url_verification') {
    return res.send({ challenge: body.challenge });
  }

  if (body.header && body.header.event_type === 'im.message.receive_v1') {
    const event = body.event;
    const messageId = event.message.message_id;
    const chatId = event.message.chat_id;
    const userMessage = event.message.content.replace(/<[^>]+>/g, '').trim();

    // Bỏ qua tin hệ thống
    if (!userMessage || userMessage.toLowerCase().includes('joined the group')) {
      return res.sendStatus(200);
    }

    // Dọn dẹp / bắt lệnh đặc biệt
    if (userMessage === '/reset') {
      clearMemory(chatId);
      await replyToLark(messageId, 'Đã xóa bộ nhớ hội thoại.');
      return res.sendStatus(200);
    }

    // 📄: Xử lý file đính kèm
    if (event.message.message_type === 'file') {
      const fileKey = event.message.file_key;
      const fileInfo = await axios.get(`https://open.larksuite.com/open-apis/im/v1/files/${fileKey}/meta`, {
        headers: { Authorization: `Bearer ${process.env.LARK_BOT_TOKEN}` },
      });
      const downloadUrl = fileInfo.data.data.download_url;
      const filename = fileInfo.data.data.name;
      const filePath = path.join(__dirname, 'uploads', filename);

      const fileRes = await axios.get(downloadUrl, { responseType: 'stream' });
      const writer = fs.createWriteStream(filePath);
      fileRes.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      let extractedText = '';
      if (filename.endsWith('.pdf')) {
        const buffer = fs.readFileSync(filePath);
        const data = await pdfParse(buffer);
        extractedText = data.text;
      } else if (filename.endsWith('.docx')) {
        const buffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value;
      } else if (filename.endsWith('.xlsx')) {
        const workbook = xlsx.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        extractedText = xlsx.utils.sheet_to_csv(sheet);
      }

      fs.unlinkSync(filePath);

      updateConversationMemory(chatId, 'user', `Nội dung file:\n${extractedText}`);
      updateConversationMemory(chatId, 'user', userMessage);
    } else if (event.message.message_type === 'image') {
      // 🖼️: OCR ảnh
      const imageKey = event.message.image_key;
      const imageInfo = await axios.get(`https://open.larksuite.com/open-apis/im/v1/images/${imageKey}/meta`, {
        headers: { Authorization: `Bearer ${process.env.LARK_BOT_TOKEN}` },
      });
      const imageUrl = imageInfo.data.data.download_url;
      const imagePath = path.join(__dirname, 'uploads', `${imageKey}.jpg`);

      const imageRes = await axios.get(imageUrl, { responseType: 'stream' });
      const writer = fs.createWriteStream(imagePath);
      imageRes.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      const result = await tesseract.recognize(imagePath, 'eng');
      const extractedText = result.data.text;
      fs.unlinkSync(imagePath);

      updateConversationMemory(chatId, 'user', `Văn bản OCR từ ảnh:\n${extractedText}`);
      updateConversationMemory(chatId, 'user', userMessage);
    } else if (userMessage.startsWith('/base')) {
      // 📊: Đọc dữ liệu từ Lark Base
      try {
        const baseToken = process.env.LARK_BOT_TOKEN;
        const baseId = userMessage.split(' ')[1]; // /base <baseId>

        const tablesRes = await axios.get(`https://open.larksuite.com/open-apis/bitable/v1/apps/${baseId}/tables`, {
          headers: { Authorization: `Bearer ${baseToken}` },
        });
        const tables = tablesRes.data.data.items;

        for (const table of tables) {
          const recordsRes = await axios.get(`https://open.larksuite.com/open-apis/bitable/v1/apps/${baseId}/tables/${table.table_id}/records?page_size=100`, {
            headers: { Authorization: `Bearer ${baseToken}` },
          });
          const rows = recordsRes.data.data.items;

          const allData = rows.map(r => r.fields);
          const jsonData = JSON.stringify(allData);

          updateConversationMemory(chatId, 'user', `Dữ liệu bảng ${table.name}:\n${jsonData}`);
        }

        updateConversationMemory(chatId, 'user', userMessage);
      } catch (err) {
        console.error(err);
        await replyToLark(messageId, 'Lỗi khi lấy dữ liệu từ Base.');
        return res.sendStatus(200);
      }
    } else {
      updateConversationMemory(chatId, 'user', userMessage);
    }

    // 🧠: Gọi AI
    const now = new Date();
    now.setHours(now.getHours() + 7);
    const nowVN = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

    try {
      const chatResponse = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'deepseek/deepseek-r1-0528-qwen3-8b:free',
          messages: [
            {
              role: 'system',
              content: `Bạn là trợ lý AI, có khả năng phân tích dữ liệu JSON từ bảng Base, file OCR, và trả lời tiếng Việt. Giờ Việt Nam hiện tại là: ${nowVN}`,
            },
            ...(conversationMemory.get(chatId) || []),
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
      updateConversationMemory(chatId, 'assistant', reply);
      await replyToLark(messageId, reply);
    } catch (err) {
      console.error('AI error:', err?.response?.data || err.message);
      await replyToLark(messageId, 'Lỗi khi gọi AI.');
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`BOT is running on port ${port}`);
});
