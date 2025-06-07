const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const pdfParse = require("pdf-parse");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || "http://localhost:" + PORT;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN;
const LARK_ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY;
const BASE_API = "https://open.larksuite.com/open-apis/bitable/v1/apps";

const chatMemories = {}; // Lưu lịch sử hội thoại theo chat_id
const fileCache = {}; // Lưu file tạm thời để đọc lại khi cần

function cleanOldMemory() {
  const now = Date.now();
  for (const key in chatMemories) {
    if (now - chatMemories[key].updatedAt > 2 * 60 * 60 * 1000) {
      delete chatMemories[key];
    }
  }
}
setInterval(cleanOldMemory, 10 * 60 * 1000); // Dọn bộ nhớ mỗi 10 phút

// === Hàm xử lý file các loại ===
async function extractTextFromFile(filePath, fileType) {
  const ext = fileType.toLowerCase();
  if (ext.includes("image")) {
    const { data: { text } } = await Tesseract.recognize(filePath, "eng+vie");
    return text;
  } else if (ext.includes("pdf")) {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  } else if (ext.includes("word") || filePath.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } else if (ext.includes("excel") || filePath.endsWith(".xlsx")) {
    const workbook = xlsx.readFile(filePath);
    let text = "";
    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const json = xlsx.utils.sheet_to_json(sheet, { header: 1 });
      json.forEach((row) => {
        text += row.join(" ") + "\n";
      });
    });
    return text;
  }
  return "";
}

// === Gửi câu hỏi sang mô hình OpenRouter ===
async function askAI(question, memory = "") {
  const messages = [
    {
      role: "system",
      content: "Bạn là trợ lý AI trả lời câu hỏi từ người dùng dựa trên thông tin cung cấp. Trả lời ngắn gọn, đúng trọng tâm.",
    },
    {
      role: "user",
      content: memory ? `Dữ liệu:\n${memory}\n\nCâu hỏi: ${question}` : question,
    },
  ];

  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "deepseek/deepseek-r1-0528-qwen3-8b:free",
      messages,
    },
    {
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  return res.data.choices[0].message.content.trim();
}

// === Lấy access token từ Lark ===
async function getTenantAccessToken() {
  const res = await axios.post("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: LARK_APP_ID,
    app_secret: LARK_APP_SECRET,
  });
  return res.data.tenant_access_token;
}

// === Lấy toàn bộ dữ liệu từ tất cả các bảng trong Base ===
async function fetchAllTables(appToken, accessToken) {
  const tableList = await axios.get(`${BASE_API}/${appToken}/tables`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const tables = tableList.data.data.items;
  const tableData = {};

  await Promise.all(
    tables.map(async (table) => {
      const tableId = table.table_id;
      let records = [];
      let pageToken = "";

      do {
        const res = await axios.get(
          `${BASE_API}/${appToken}/tables/${tableId}/records?page_size=500${pageToken ? `&page_token=${pageToken}` : ""}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        records = records.concat(res.data.data.items);
        pageToken = res.data.data.page_token || "";
      } while (pageToken);

      tableData[table.name] = records.map((r) => r.fields); // chỉ lấy fields gọn cho AI
    })
  );

  return tableData;
}

// === Trả lời sự kiện từ Lark ===
app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Xác minh
  if (body.type === "url_verification") {
    return res.send({ challenge: body.challenge });
  }

  // Sự kiện tin nhắn
  if (body.header && body.header.event_type === "im.message.receive_v1") {
    const event = body.event;
    const message = event.message;
    const chat_id = event.message.chat_id;
    const sender_id = event.sender.sender_id.user_id;

    // Lấy nội dung
    const content = JSON.parse(message.content);
    const text = content.text || "";

    // Gửi đang xử lý
    await axios.post(
      "https://open.larksuite.com/open-apis/im/v1/messages",
      {
        receive_id: chat_id,
        content: JSON.stringify({ text: "⏳ Đang xử lý..." }),
        msg_type: "text",
      },
      {
        headers: {
          Authorization: `Bearer ${await getTenantAccessToken()}`,
          "Content-Type": "application/json",
          "Receive-Id-Type": "chat_id",
        },
      }
    );

    // Nếu người dùng nói: "@bot đọc file vừa gửi"
    if (text.toLowerCase().includes("đọc file")) {
      const lastFile = fileCache[chat_id];
      if (!lastFile) {
        return res.sendStatus(200);
      }
      const extracted = await extractTextFromFile(lastFile.path, lastFile.type);
      const reply = await askAI(text, extracted);
      return sendReply(chat_id, reply);
    }

    // Nếu người dùng hỏi về bảng
    if (text.toLowerCase().includes("bảng") || text.toLowerCase().includes("po") || text.match(/tháng\s+\d+/i)) {
      const accessToken = await getTenantAccessToken();
      const tableData = await fetchAllTables("appbmv3Vp6DvCyT2ZGq", accessToken);

      // Ghép tất cả bảng thành 1 khối JSON nhỏ gọn
      let fullData = "";
      for (const [name, rows] of Object.entries(tableData)) {
        const small = rows.slice(0, 100); // chỉ lấy 100 dòng đầu tránh quá dài
        fullData += `\n\nBảng: ${name}\n${JSON.stringify(small, null, 2)}`;
      }

      const reply = await askAI(text, fullData);
      return sendReply(chat_id, reply);
    }

    // Nếu không phải file hay bảng → hỏi như thường
    const memory = chatMemories[chat_id]?.memory || "";
    const reply = await askAI(text, memory);

    chatMemories[chat_id] = {
      memory: (memory + "\n" + text + "\n" + reply).slice(-4000),
      updatedAt: Date.now(),
    };

    await sendReply(chat_id, reply);
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// === Hàm gửi trả lời về Lark ===
async function sendReply(chat_id, text) {
  const accessToken = await getTenantAccessToken();
  await axios.post(
    "https://open.larksuite.com/open-apis/im/v1/messages",
    {
      receive_id: chat_id,
      content: JSON.stringify({ text }),
      msg_type: "text",
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Receive-Id-Type": "chat_id",
      },
    }
  );
}

// === Nhận file từ Lark ===
app.post("/file", async (req, res) => {
  const { chat_id, file_url, file_name, file_type } = req.body;

  const filePath = path.join(__dirname, "downloads", `${Date.now()}_${file_name}`);
  const writer = fs.createWriteStream(filePath);
  const response = await axios.get(file_url, { responseType: "stream" });
  response.data.pipe(writer);
  writer.on("finish", () => {
    fileCache[chat_id] = { path: filePath, type: file_type };
    res.send("Đã lưu file");
  });
});

app.listen(PORT, () => {
  console.log(`Bot đang chạy tại ${DOMAIN}`);
});
