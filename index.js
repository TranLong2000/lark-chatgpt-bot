import express from "express";
import crypto from "crypto";
import bodyParser from "body-parser";
import OpenAI from "openai";

const app = express();
const port = process.env.PORT || 8080;

// Xử lý base64 url-safe của Lark
function base64UrlToBase64(base64Url) {
  let base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) base64 += "=";
  return base64;
}

const rawEncryptKey = process.env.LARK_ENCRYPT_KEY;
const base64Key = base64UrlToBase64(rawEncryptKey);
const encryptKey = Buffer.from(base64Key, "base64");

if (encryptKey.length !== 32) {
  throw new Error(
    `LARK_ENCRYPT_KEY sau decode phải đủ 32 bytes, hiện tại là ${encryptKey.length}`
  );
}

const verificationToken = process.env.LARK_VERIFICATION_TOKEN;

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

function decryptEncryptKey(encryptData, iv) {
  const decipher = crypto.createDecipheriv("aes-256-cbc", encryptKey, iv);
  let decrypted = decipher.update(encryptData, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/webhook", async (req, res) => {
  try {
    if (req.headers["x-lark-verify-token"] !== verificationToken) {
      console.log("Sai verification token");
      return res.status(403).send("Forbidden");
    }

    const encrypt = req.body.encrypt;
    if (!encrypt) {
      console.log("Không có encrypt trong body");
      return res.status(400).send("Bad Request");
    }

    const encryptBuffer = Buffer.from(encrypt, "base64");
    const iv = encryptBuffer.slice(0, 16);
    const encryptedData = encryptBuffer.slice(16).toString("base64");

    const decryptedText = decryptEncryptKey(encryptedData, iv);
    const decryptedJson = JSON.parse(decryptedText);

    if (decryptedJson.type === "url_verification") {
      return res.json({ challenge: decryptedJson.challenge });
    }

    if (decryptedJson.type === "event_callback") {
      const event = decryptedJson.event;
      if (event.type === "im.message.receive_v1") {
        const msgText = event.message && event.message.text;
        console.log("Nhận message:", msgText);

        // Gọi OpenAI chat
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Bạn là trợ lý hỗ trợ người dùng." },
            { role: "user", content: msgText },
          ],
        });

        const replyText = completion.choices[0].message.content;
        console.log("Trả lời GPT:", replyText);

        // Trả về ok cho Lark
        return res.json({ msg: "ok" });
      }
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error("Webhook xử lý lỗi:", e);
    return res.status(500).send("Internal Server Error");
  }
});

app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});
