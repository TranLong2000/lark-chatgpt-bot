// oaSummary.js
const axios = require("axios");

const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;

// Danh sách tất cả các bảng cần tổng hợp
const BASES = [
  { appToken: "Um8Zb07ayaDFAws9BRFlbZtngZf", tableId: "tblc0IuDKdYrVGqo" },
  { appToken: "ISmubRaYVapU5Js4rgmlMEaMgxd", tableId: "tblwV1amW2IKE8S9" },
  { appToken: "LuXxbG9NHaHWerspe3llcnnMgze", tableId: "tblINGRM9I5ns5iM" },
];

async function getTenantToken() {
  const res = await axios.post("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: LARK_APP_ID,
    app_secret: LARK_APP_SECRET,
  });
  return res.data.tenant_access_token;
}

async function fetchAllUnderReviewRequests() {
  const accessToken = await getTenantToken();
  let allRecords = [];

  for (const base of BASES) {
    try {
      const response = await axios.get(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${base.appToken}/tables/${base.tableId}/records?page_size=100`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      const records = response.data.data.items;

      const underReview = records.filter(
        (r) => r.fields["Status"] && r.fields["Status"].toLowerCase() === "under review"
      );

      allRecords = allRecords.concat(underReview);
    } catch (error) {
      console.error(`❌ Lỗi khi đọc base ${base.appToken}:`, error.response?.data || error.message);
    }
  }

  return allRecords;
}

async function fetchUnderReviewRequests() {
  const allRecords = await fetchAllUnderReviewRequests();

  if (allRecords.length === 0) {
    return "✅ Hiện tại không có đơn nào đang *Under Review* trong tất cả các bảng.";
  }

  const grouped = {};

  allRecords.forEach((r) => {
    const fields = r.fields;
    const requester = fields["Requester"] || "Không rõ";
    const requestNo = fields["Request No."] || "Không rõ";
    const assignee = fields["Current assignee"] || "Không rõ";

    if (!grouped[requester]) grouped[requester] = [];
    grouped[requester].push({ requestNo, assignee });
  });

  let message = `📋 **Tổng hợp các Request đang *Under Review* từ 3 bảng:**\n\n`;

  for (const requester in grouped) {
    message += `👤 ${requester}\n`;
    grouped[requester].forEach((item) => {
      message += `- ${item.requestNo} → Người duyệt: ${item.assignee}\n`;
    });
    message += `\n`;
  }

  return message.trim();
}

module.exports = { fetchUnderReviewRequests };
