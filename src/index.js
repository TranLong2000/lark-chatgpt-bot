require("dotenv").config();
const express = require("express");
const { Client, ConsoleLogger, LogLevel } = require("@larksuiteoapi/node-sdk");
const { getMemory, saveMemory } = require("./memory");
const { callOpenRouter } = require("./openai");
const { getTextFromMessage } = require("./utils");
const { fetchOAData, sendToGroup } = require("./oaSummary");
const cron = require("node-cron");

const app = express();
app.use(express.json());

// Khởi tạo Lark SDK
const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  logger: new ConsoleLogger({ level: LogLevel.DEBUG }),
});

app.post("/webhook", async (req, res) => {
  const event = req.body.event;
  const eventType = req.body.header?.event_type;

  if (eventType === "im.message.receive_v1") {
    const text = getTextFromMessage(event.message);
    const chatId = event.message.chat_id;

    // Nếu người dùng hỏi về đơn thanh toán → phản hồi bảng
    if (/đơn thanh toán|bảng OA|tổng hợp/i.test(text)) {
      const { text: summary } = await fetchOAData();
      await client.im.message.create({
        receive_id_type: "chat_id",
        params: { receive_id: chatId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: summary }),
        },
      });
      return res.send("ok");
    }

    // Dùng AI như hiện tại
    const memory = await getMemory(chatId);
    const reply = await callOpenRouter(text, memory);

    await saveMemory(chatId, text, reply);

    await client.im.message.create({
      receive_id_type: "chat_id",
      params: { receive_id: chatId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text: reply }),
      },
    });
  }

  res.send("ok");
});

// Cron gửi tổng hợp bảng lúc 15h mỗi ngày
cron.schedule("0 15 * * *", async () => {
  console.log("⏰ Đến giờ gửi báo cáo đơn thanh toán...");
  try {
    const { text } = await fetchOAData();
    await sendToGroup(text);
    console.log("✅ Đã gửi báo cáo");
  } catch (err) {
    console.error("❌ Lỗi gửi báo cáo:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy ở cổng ${PORT}`);
});
