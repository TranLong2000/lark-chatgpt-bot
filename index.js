const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const axiosRetry = require("axios-retry");
const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js");
const mammoth = require("mammoth");
const xlsx = require("xlsx");
const pdfParse = require("pdf-parse");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Kiểm tra biến môi trường
const requiredEnvVars = [
  "OPENROUTER_API_KEY",
  "LARK_APP_ID",
  "LARK_APP_SECRET",
  "LARK_VERIFICATION_TOKEN",
  "LARK_ENCRYPT_KEY",
];
const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(", ")}`);
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN;
const LARK_ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY;
const BASE_API = "https://open.larksuite.com/open-apis/bitable/v1/apps";

// Cấu hình retry cho axios
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => retryCount * 1000,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status >= 500;
  },
});

const chatMemories = {};
const fileCache = {};
const baseSchemaCache = {};

function cleanOldMemory() {
  const now = Date.now();
  for (const key in chatMemories) {
    if (now - chatMemories[key].updatedAt > 2 * 60 * 60 * 1000) {
      delete chatMemories[key];
    }
  }
}
setInterval(cleanOldMemory, 10 * 60 * 1000);

// === SMART QUESTION ANALYSIS ===
async function analyzeQuestion(question) {
  const analysisPrompt = `
Phân tích câu hỏi của người dùng và trả về JSON với format:
{
  "intent": "search|summary|calculate|compare|list",
  "keywords": ["từ", "khóa", "quan", "trọng"],
  "timeframe": "tháng X" hoặc "năm Y" hoặc null,
  "entities": ["tên bảng", "cột", "giá trị cần tìm"],
  "dataTypes": ["number", "text", "date"],
  "complexity": "simple|medium|complex"
}

Câu hỏi: "${question}"
`;

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "deepseek/deepseek-r1-0528-qwen3-8b:free",
        messages: [
          {
            role: "system",
            content: "Bạn là chuyên gia phân tích câu hỏi. Chỉ trả về JSON, không giải thích thêm.",
          },
          {
            role: "user",
            content: analysisPrompt,
          },
        ],
        temperature: 0.1,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const result = response.data.choices[0].message.content.trim();
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (error) {
    console.log("Question analysis failed:", error.message);
    return {
      intent: "search",
      keywords: question.split(" ").filter((w) => w.length > 2),
      timeframe: null,
      entities: [],
      dataTypes: ["text"],
      complexity: "simple",
    };
  }
}

// === SMART BASE SCHEMA DISCOVERY ===
async function getBaseSchema(appToken, accessToken) {
  if (baseSchemaCache[appToken]) {
    return baseSchemaCache[appToken];
  }

  try {
    const tableList = await axios.get(`${BASE_API}/${appToken}/tables`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const schema = {};

    for (const table of tableList.data.data.items) {
      const fieldsRes = await axios.get(
        `${BASE_API}/${appToken}/tables/${table.table_id}/fields`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      schema[table.name] = {
        table_id: table.table_id,
        fields: fieldsRes.data.data.items.map((field) => ({
          name: field.field_name,
          type: field.type,
          id: field.field_id,
        })),
        description: `Bảng ${table.name} có ${fieldsRes.data.data.items.length} cột`,
      };
    }

    baseSchemaCache[appToken] = schema;
    return schema;
  } catch (error) {
    console.log("Schema discovery failed:", error.message);
    return {};
  }
}

// === SMART DATA RETRIEVAL ===
async function smartDataRetrieval(appToken, accessToken, analysis, schema) {
  const relevantTables = findRelevantTables(schema, analysis);
  const retrievedData = {};

  for (const [tableName, tableInfo] of Object.entries(relevantTables)) {
    try {
      const filterCondition = buildSmartFilter(analysis, tableInfo);

      let records = [];
      let pageToken = "";
      let maxRecords = analysis.complexity === "simple" ? 100 : 500;

      do {
        const url = `${BASE_API}/${appToken}/tables/${tableInfo.table_id}/records`;
        const params = new URLSearchParams({
          page_size: Math.min(100, maxRecords - records.length).toString(),
        });

        if (pageToken) params.append("page_token", pageToken);
        if (filterCondition) params.append("filter", filterCondition);

        const res = await axios.get(`${url}?${params}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const newRecords = res.data.data.items || [];
        records = records.concat(newRecords);
        pageToken = res.data.data.page_token || "";
      } while (pageToken && records.length < maxRecords);

      retrievedData[tableName] = {
        schema: tableInfo.fields,
        data: records.map((r) => processRecord(r.fields, tableInfo.fields)),
        count: records.length,
        summary: generateDataSummary(records, tableInfo.fields),
      };
    } catch (error) {
      console.log(`Failed to retrieve data from ${tableName}:`, error.message);
      retrievedData[tableName] = { error: error.message };
    }
  }

  return retrievedData;
}

// === HELPER FUNCTIONS ===
function findRelevantTables(schema, analysis) {
  const relevant = {};
  const keywords = analysis.keywords.map((k) => k.toLowerCase());

  for (const [tableName, tableInfo] of Object.entries(schema)) {
    let relevanceScore = 0;

    if (keywords.some((k) => tableName.toLowerCase().includes(k))) {
      relevanceScore += 10;
    }

    for (const field of tableInfo.fields) {
      if (keywords.some((k) => field.name.toLowerCase().includes(k))) {
        relevanceScore += 5;
      }
    }

    if (
      analysis.entities.some(
        (e) =>
          tableName.toLowerCase().includes(e.toLowerCase()) ||
          tableInfo.fields.some((f) => f.name.toLowerCase().includes(e.toLowerCase()))
      )
    ) {
      relevanceScore += 15;
    }

    if (relevanceScore > 0) {
      relevant[tableName] = { ...tableInfo, relevanceScore };
    }
  }

  return Object.fromEntries(
    Object.entries(relevant)
      .sort(([, a], [, b]) => b.relevanceScore - a.relevanceScore)
      .slice(0, 3)
  );
}

function buildSmartFilter(analysis, tableInfo) {
  const filters = [];

  if (analysis.timeframe) {
    const timeMatch = analysis.timeframe.match(/tháng\s+(\d+)|năm\s+(\d+)/i);
    if (timeMatch) {
      const dateFields = tableInfo.fields.filter(
        (f) =>
          f.type === "DateTime" ||
          f.name.toLowerCase().includes("ngày") ||
          f.name.toLowerCase().includes("time") ||
          f.name.toLowerCase().includes("date")
      );

      if (dateFields.length > 0) {
        const month = timeMatch[1];
        const year = timeMatch[2] || new Date().getFullYear();

        if (month) {
          filters.push(`AND(MONTH(${dateFields[0].name}) = ${month})`);
        }
        if (year) {
          filters.push(`AND(YEAR(${dateFields[0].name}) = ${year})`);
        }
      }
    }
  }

  const textFields = tableInfo.fields.filter((f) => f.type === "Text");
  if (textFields.length > 0 && analysis.keywords.length > 0) {
    const keywordFilters = analysis.keywords.map((keyword) =>
      textFields.map((field) => `SEARCH("${keyword}", ${field.name}) > 0`).join(" OR ")
    );
    if (keywordFilters.length > 0) {
      filters.push(`OR(${keywordFilters.join(", ")})`);
    }
  }

  return filters.length > 0 ? `AND(${filters.join(", ")})` : null;
}

function processRecord(fields, schema) {
  const processed = {};

  for (const [fieldName, value] of Object.entries(fields)) {
    const fieldInfo = schema.find((f) => f.name === fieldName);

    if (value && fieldInfo) {
      switch (fieldInfo.type) {
        case "Number":
          processed[fieldName] = parseFloat(value) || 0;
          break;
        case "Currency":
          processed[fieldName] = parseFloat(value) || 0;
          break;
        case "DateTime":
          processed[fieldName] = new Date(value).toLocaleDateString("vi-VN");
          break;
        case "MultiSelect":
        case "SingleSelect":
          processed[fieldName] = Array.isArray(value) ? value.join(", ") : value;
          break;
        default:
          processed[fieldName] = value;
      }
    }
  }

  return processed;
}

function generateDataSummary(records, schema) {
  const summary = {
    totalRecords: records.length,
    numericSummary: {},
    categoricalSummary: {},
  };

  const numericFields = schema.filter((f) => ["Number", "Currency"].includes(f.type));
  const textFields = schema.filter((f) => ["Text", "SingleSelect"].includes(f.type));

  for (const field of numericFields) {
    const values = records
      .map((r) => parseFloat(r.fields[field.name]) || 0)
      .filter((v) => v > 0);
    if (values.length > 0) {
      summary.numericSummary[field.name] = {
        sum: values.reduce((a, b) => a + b, 0),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        count: values.length,
      };
    }
  }

  for (const field of textFields.slice(0, 3)) {
    const values = records.map((r) => r.fields[field.name]).filter((v) => v);
    const counts = {};
    values.forEach((v) => (counts[v] = (counts[v] || 0) + 1));

    summary.categoricalSummary[field.name] = Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {});
  }

  return summary;
}

// === ENHANCED AI RESPONSE ===
async function generateSmartResponse(question, analysis, retrievedData) {
  const contextPrompt = `
Bạn là chuyên gia phân tích dữ liệu. Dựa trên câu hỏi và dữ liệu được cung cấp, hãy đưa ra câu trả lời chính xác và hữu ích.

PHÂN TÍCH CÂU HỎI:
- Ý định: ${analysis.intent}
- Từ khóa: ${analysis.keywords.join(", ")}
- Thời gian: ${analysis.timeframe || "Không xác định"}
- Độ phức tạp: ${analysis.complexity}

DỮ LIỆU ĐÃ TRUY XUẤT:
${Object.entries(retrievedData)
  .map(
    ([tableName, data]) => `
Bảng: ${tableName}
- Số bản ghi: ${data.count || 0}
- Cấu trúc: ${data.schema ? data.schema.map((f) => f.name).join(", ") : "N/A"}
- Tóm tắt số liệu: ${JSON.stringify(data.summary?.numericSummary || {}, null, 2)}
- Dữ liệu mẫu (5 bản ghi đầu): ${JSON.stringify(data.data?.slice(0, 5) || [], null, 2)}
`
  )
  .join("\n")}

CÂU HỎI: "${question}"

Hãy trả lời:
1. Ngắn gọn và đúng trọng tâm
2. Dựa trên dữ liệu thực tế
3. Bao gồm số liệu cụ thể nếu có
4. Nếu không tìm thấy dữ liệu phù hợp, hãy nói rõ
5. Đề xuất câu hỏi tương tự nếu cần thiết
`;

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "deepseek/deepseek-r1-0528-qwen3-8b:free",
        messages: [
          {
            role: "system",
            content: "Bạn là chuyên gia phân tích dữ liệu thông minh, trả lời chính xác dựa trên dữ liệu có sẵn.",
          },
          {
            role: "user",
            content: contextPrompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.log("Smart response generation failed:", error.message);
    return "Xin lỗi, tôi gặp lỗi khi phân tích dữ liệu. Vui lòng thử lại sau.";
  }
}

// === FILE PROCESSING ===
async function extractTextFromFile(filePath, fileType) {
  try {
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
  } catch (error) {
    console.log("File extraction failed:", error.message);
    return "";
  }
}

// === AUTH FUNCTIONS ===
async function getTenantAccessToken() {
  try {
    const res = await axios.post(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
      {
        app_id: LARK_APP_ID,
        app_secret: LARK_APP_SECRET,
      }
    );
    return res.data.tenant_access_token;
  } catch (error) {
    console.log("Failed to get access token:", error.message);
    throw error;
  }
}

// === MAIN WEBHOOK HANDLER ===
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.type === "url_verification") {
    return res.send({ challenge: body.challenge });
  }

  if (body.header && body.header.event_type === "im.message.receive_v1") {
    const event = body.event;
    const message = event.message;
    const chat_id = event.message.chat_id;
    const sender_id = event.sender.sender_id.user_id;

    const content = JSON.parse(message.content);
    const question = content.text || "";

    if (!question.trim()) {
      return res.sendStatus(200);
    }

    try {
      await sendReply(chat_id, "🤖 Đang phân tích câu hỏi và truy xuất dữ liệu...");
    } catch (error) {
      console.log("Failed to send processing message:", error.message);
    }

    try {
      if (question.toLowerCase().includes("đọc file")) {
        const lastFile = fileCache[chat_id];
        if (!lastFile) {
          await sendReply(chat_id, "❌ Không tìm thấy file nào được gửi trước đó.");
          return res.sendStatus(200);
        }
        const extracted = await extractTextFromFile(lastFile.path, lastFile.type);
        const reply = await generateSmartResponse(question, { intent: "search", keywords: ["file"], complexity: "simple" }, { file: { data: extracted } });
        await sendReply(chat_id, reply);
        return res.sendStatus(200);
      }

      console.log("🔍 Analyzing question:", question);

      const analysis = await analyzeQuestion(question);
      console.log("📊 Question analysis:", analysis);

      const accessToken = await getTenantAccessToken();
      const schema = await getBaseSchema("appbmv3Vp6DvCyT2ZGq", accessToken);
      console.log("📋 Available tables:", Object.keys(schema));

      const retrievedData = await smartDataRetrieval("appbmv3Vp6DvCyT2ZGq", accessToken, analysis, schema);
      console.log("💾 Retrieved data from tables:", Object.keys(retrievedData));

      const smartReply = await generateSmartResponse(question, analysis, retrievedData);

      chatMemories[chat_id] = {
        memory: (chatMemories[chat_id]?.memory || "").slice(-2000) + `\nQ: ${question}\nA: ${smartReply}`,
        updatedAt: Date.now(),
      };

      await sendReply(chat_id, smartReply);
    } catch (error) {
      console.error("Error in smart processing:", error);
      try {
        await sendReply(chat_id, "❌ Có lỗi xảy ra khi xử lý câu hỏi. Vui lòng thử lại sau.");
      } catch (replyError) {
        console.error("Failed to send error message:", replyError);
      }
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// === UTILITY FUNCTIONS ===
async function sendReply(chat_id, text) {
  try {
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
  } catch (error) {
    console.log("Failed to send reply:", error.message);
    throw error;
  }
}

// Tạo thư mục downloads nếu chưa có
const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

app.post("/file", async (req, res) => {
  try {
    const { chat_id, file_url, file_name, file_type } = req.body;

    // Kiểm tra kích thước file
    const headResponse = await axios.head(file_url);
    const fileSize = parseInt(headResponse.headers["content-length"] || 0);
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (fileSize > maxSize) {
      return res.status(400).send("File quá lớn, tối đa 10MB");
    }

    const filePath = path.join(__dirname, "downloads", `${Date.now()}_${file_name}`);
    const writer = fs.createWriteStream(filePath);
    const response = await axios.get(file_url, { responseType: "stream" });

    response.data.pipe(writer);

    writer.on("finish", () => {
      fileCache[chat_id] = { path: filePath, type: file_type };
      res.send("Đã lưu file");
    });

    writer.on("error", (error) => {
      console.error("File download error:", error);
      res.status(500).send("Lỗi khi lưu file");
    });
  } catch (error) {
    console.error("File handling error:", error);
    res.status(500).send("Lỗi xử lý file");
  }
});

// Khởi động server và xử lý graceful shutdown
const server = app.listen(PORT, () => {
  console.log(`🚀 Smart Lark AI Bot running at ${DOMAIN}`);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM. Performing graceful shutdown...");
  server.close(() => {
    console.log("Server closed. Exiting process...");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Graceful shutdown timed out. Forcing exit...");
    process.exit(1);
  }, 10000);
});
