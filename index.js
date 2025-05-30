import Koa from "koa";
import bodyParser from "koa-bodyparser";
import { Client } from "@larksuiteoapi/node-sdk";
import OpenAI from "openai";

const app = new Koa();

// Khởi tạo client Lark
const client = new Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
});

// Khởi tạo OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(bodyParser());

app.use(async (ctx) => {
  if (ctx.path === "/webhook" && ctx.method === "POST") {
    // Xác thực verify token Lark
    const verifyToken = process.env.LARK_VERIFICATION_TOKEN;
    const tokenFromHeader = ctx.headers["x-lark-request-token"];

    if (!tokenFromHeader || tokenFromHeader !== verifyToken) {
      ctx.status = 401;
      ctx.body = "[❌] Invalid verify token";
      return;
    }

    // Xử lý sự kiện Lark webhook
    const event = ctx.request.body;

    // Ví dụ: xử lý sự kiện message.receive
    if (event.type === "im.message.receive_v2") {
      const message = event.event.message;
      const chatId = message.chat_id;
      const userText = message.text;

      // Gọi OpenAI API để lấy phản hồi
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: userText }],
      });

      const replyText = completion.choices[0].message.content;

      // Gửi trả lời qua Lark API
      await client.im.message.reply({
        message_id: message.message_id,
        content: JSON.stringify({
          text: replyText,
        }),
      });

      ctx.body = "ok";
      return;
    }

    // Trả về ok với các sự kiện khác
    ctx.body = "ok";
    return;
  }

  ctx.status = 404;
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
