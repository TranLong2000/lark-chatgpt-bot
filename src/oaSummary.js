// src/oaSummary.js
const axios = require("axios");

const APP_TOKEN = "Um8Zb07ayaDFAws9BRFlbZtngZf";
const TABLE_ID = "tblc0IuDKdYrVGqo";

async function getAppAccessToken() {
  const res = await axios.post("https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal", {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  });
  return res.data.app_access_token;
}

async function fetchOAData() {
  const token = await getAppAccessToken();

  const res = await axios.get(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  const items = res.data.data.items;

  const rows = items.map((item, index) => {
    const f = item.fields;
    return `${index + 1}. ${f["Tên nhân viên"] || "?"} - ${f["Số tiền"] || "?"} - ${f["Trạng thái"] || "?"}`;
  });

  const text = rows.length > 0
    ? `📋 Tổng hợp đơn thanh toán:\n${rows.join("\n")}`
    : "📋 Không có đơn thanh toán nào.";

  return { token, text };
}

async function sendToGroup(text, tokenOverride = null) {
  const token = tokenOverride || (await getAppAccessToken());

  await axios.post(
    "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      receive_id: process.env.CHAT_ID,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );
}

module.exports = {
  fetchOAData,
  sendToGroup,
};
