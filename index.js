   // =========================
   // index.js — L-GPT (Lark)
   // =========================
   
   /* ===== Core deps ===== */
   const express = require('express');
   const crypto = require('crypto');
   const axios = require('axios');
   const fs = require('fs');
   const path = require('path');
   const pdfParse = require('pdf-parse');
   const mammoth = require('mammoth');
   const xlsx = require('xlsx');
   const Tesseract = require('tesseract.js');
   const moment = require('moment-timezone');
   const QuickChart = require('quickchart-js');
   require('dotenv').config();
   
   /* ===== App boot ===== */
   const app = express();
   const port = process.env.PORT || 8080;
   
   /* ===============================
      SECTION 1 — Config mappings
      =============================== */
   const BASE_MAPPINGS = {
     PUR:  'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbl61rgzOwS8viB2&view=vewi5cxZif',
     SALE: 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tblClioOV3nPN6jM&view=vew7RMyPed',
     FIN:  'https://cgfscmkep8m.sg.larksuite.com/base/Um8Zb07ayaDFAws9BRFlbZtngZf?table=tblc0IuDKdYrVGqo&view=vewU8BLeBr',
     TEST: 'https://cgfscmkep8m.sg.larksuite.com/base/PjuWbiJLeaOzBMskS4ulh9Bwg9d?table=tbllwXLQBdRgex9z&view=vewksBlcon',
     PAY:  'https://cgfscmkep8m.sg.larksuite.com/base/UBrwbz2tHaeEwosVO5dlV0Lcgqb?table=tblQcpErvmsBpWCh&view=vewIQhfi04'
   };
   
   const SHEET_MAPPINGS = {
     PUR_SHEET: 'https://cgfscmkep8m.sg.larksuite.com/sheets/Qd5JsUX0ehhqO9thXcGlyAIYg9g?sheet=6eGZ0D'
   };
   
   /* ===============================
      SECTION 2 — Global constants
      =============================== */
   let lastB2Value = null;
   const SPREADSHEET_TOKEN = 'LYYqsXmnPhwwGHtKP00lZ1IWgDb';
   const SHEET_ID = '48e2fd';
   const GROUP_CHAT_IDS = (process.env.LARK_GROUP_CHAT_IDS || '')
     .split(',')
     .map(s => s.trim())
     .filter(Boolean);
   const BOT_OPEN_ID = process.env.BOT_OPEN_ID;
   
   /* ===============================
      SECTION 3 — Runtime stores
      =============================== */
   const processedMessageIds = new Set();
   const conversationMemory = new Map();
   const pendingTasks = new Map();
   const pendingFiles = new Map();
   
   if (!fs.existsSync('temp_files')) fs.mkdirSync('temp_files');
   
   /* ===============================
      SECTION 4 — Express middleware
      =============================== */
   app.use('/webhook', express.raw({ type: '*/*', limit: '10mb', timeout: 60000 }));
   app.use('/webhook-base', express.json({ limit: '10mb', timeout: 60000 }));
   
   /* ========================================
      SECTION 5 — Verify & Decrypt utilities
      ======================================== */
   function verifySignature(timestamp, nonce, body, signature) {
     const encryptKey = process.env.LARK_ENCRYPT_KEY;
     if (!encryptKey) return false;
     const raw = `${timestamp}${nonce}${encryptKey}${body}`;
     const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
     return hash === signature;
   }
   
   function decryptMessage(encrypt) {
     const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'utf-8');
     const aesKey = crypto.createHash('sha256').update(key).digest();
     const data = Buffer.from(encrypt, 'base64');
     const iv = data.slice(0, 16);
     const encryptedText = data.slice(16);
     const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
     let decrypted = decipher.update(encryptedText);
     decrypted = Buffer.concat([decrypted, decipher.final()]);
     return JSON.parse(decrypted.toString());
   }
   
   /* ===========================================
      SECTION 6 — Lark helpers (user & reply)
      =========================================== */
   async function getUserInfo(openId, token) {
     try {
       const response = await axios.get(
         `${process.env.LARK_DOMAIN}/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
         { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
       );
       return response.data.data.user.name || `User_${openId.slice(-4)}`;
     } catch {
       return `User_${openId.slice(-4)}`;
     }
   }
   
   async function getAppAccessToken() {
     try {
       const resp = await axios.post(
         `${process.env.LARK_DOMAIN}/open-apis/auth/v3/app_access_token/internal`,
         { app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET },
         { timeout: 20000 }
       );
       return resp.data.app_access_token;
     } catch {
       throw new Error('Lỗi lấy token');
     }
   }
   
   async function replyToLark(messageId, content, mentionUserId = null, mentionUserName = null) {
     try {
       const token = await getAppAccessToken();
       const isSelfMention = mentionUserId === BOT_OPEN_ID;
       const messageContent = (!isSelfMention && mentionUserId && mentionUserName)
         ? { text: `${content} <at user_id="${mentionUserId}">${mentionUserName}</at>` }
         : { text: content };
   
       await axios.post(
         `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages/${messageId}/reply`,
         { msg_type: 'text', content: JSON.stringify(messageContent) },
         { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
       );
     } catch { /* nuốt lỗi trả lời để không crash */ }
   }
   
   /* ===================================================
      SECTION 7 — File/Image extract (PDF/DOCX/XLSX/OCR)
      =================================================== */
   async function extractFileContent(fileUrl, fileType) {
     try {
       const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
       const buffer = Buffer.from(response.data);
   
       if (fileType === 'pdf') {
         const data = await pdfParse(buffer);
         return (data.text || '').trim();
       }
       if (fileType === 'docx') {
         const result = await mammoth.extractRawText({ buffer });
         return (result.value || '').trim();
       }
       if (fileType === 'xlsx') {
         const workbook = xlsx.read(buffer, { type: 'buffer' });
         const sheetName = workbook.SheetNames[0];
         const sheet = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
         return sheet.map(row => (row || []).join(', ')).join('; ');
       }
       if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileType)) {
         const result = await Tesseract.recognize(buffer, 'eng+vie');
         return (result.data.text || '').trim();
       }
       return 'Không hỗ trợ loại file này.';
     } catch {
       return 'Lỗi khi trích xuất nội dung file';
     }
   }
   
   /* =======================================
      SECTION 8 — Bitable & Sheets helpers
      ======================================= */
   async function getTableMeta(baseId, tableId, token) {
     try {
       const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/meta`;
       const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
       return (resp.data.data.fields || []).map(f => ({ name: f.name, field_id: f.field_id }));
     } catch { return []; }
   }
   
   async function getAllRows(baseId, tableId, token, requiredFields = []) {
     if (global.lastRows && global.lastRows.baseId === baseId && global.lastRows.tableId === tableId) {
       return global.lastRows.rows;
     }
     const rows = [];
     let pageToken = '';
     do {
       const url = `${process.env.LARK_DOMAIN}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=20&page_token=${pageToken}`;
       try {
         const resp = await axios.get(url, {
           headers: { Authorization: `Bearer ${token}` },
           params: requiredFields.length ? { field_names: requiredFields.join(',') } : {},
           timeout: 30000
         });
         rows.push(...(resp.data?.data?.items || []));
         pageToken = resp.data?.data?.page_token || '';
       } catch { break; }
     } while (pageToken && rows.length < 200);
     global.lastRows = { baseId, tableId, rows };
     return rows;
   }
   
   async function getSheetData(spreadsheetToken, token, range = 'A:AK') {
     const base = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values`;
     const url = `${base}/${range}${range.includes('?') ? '&' : '?'}valueRenderOption=FormattedValue`;
     const timeout = 60000, maxRetries = 2;
     for (let attempt = 0; attempt <= maxRetries; attempt++) {
       try {
         const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout });
         return resp?.data?.data?.valueRange?.values || [];
       } catch (err) {
         if (attempt === maxRetries) return [];
         await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
       }
     }
     return [];
   }
   
   /* ==================================================
      SECTION 9 — Utility funcs (columns, numbers, etc.)
      ================================================== */
   function colToIndex(col) {
     let idx = 0;
     for (let i = 0; i < col.length; i++) idx = idx * 26 + (col.charCodeAt(i) - 64);
     return idx - 1;
   }
   function toNumber(v) {
     if (v === null || v === undefined) return 0;
     const s = String(v).trim().replace(/,/g, '');
     const n = parseFloat(s);
     return Number.isFinite(n) ? n : 0;
   }
   
  /* ==========================================================
   SECTION 10 — Sales compare + message (scheduled analysis)
   ========================================================== */
async function getSaleComparisonData(token, prevCol, currentCol) {
  try {
    const rows = await getSheetData(SPREADSHEET_TOKEN, token, `${SHEET_ID}!A:AK`);
    console.log("DEBUG sheet rows length:", rows.length);
    console.log("DEBUG first 3 rows:", rows.slice(0, 3));

    if (!rows || rows.length <= 1) return [];
    const col = { A:0,E:4,F:5,G:6,M:12,N:13,O:14,P:15,Q:16,AK:36 };
    const prevIdx = colToIndex(prevCol);
    const currIdx = colToIndex(currentCol);

    const data = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const productName = r[col.E] ?? `Dòng ${i + 1}`;
      const warehouse   = r[col.F] ?? '';
      const stock       = toNumber(r[col.G]);
      const avr7daysRaw = r[col.M] ?? '';
      const sale3day    = toNumber(r[col.N]);
      const sale2day    = toNumber(r[col.O]);
      const sale1day    = toNumber(r[col.P]);
      const finalStatus = (r[col.AK] ?? '').toString().trim();
      const prev    = toNumber(r[prevIdx]);
      const current = toNumber(r[currIdx]);
      let change = 0;
      if (prev === 0 && current > 0) change = Infinity;
      else if (prev > 0) change = ((current - prev) / prev) * 100;

      data.push({
        productName, warehouse, finalStatus, stock,
        avr7days: avr7daysRaw, sale3day, sale2day, sale1day,
        prev, current, change
      });
    }
    return data;
  } catch (err) { 
    console.error("Lỗi khi lấy dữ liệu sheet:", err);
    return [];
  }
}

async function analyzeSalesChange(token) {
  const nowVN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const hourVN = nowVN.getHours();
  const prevCol = 'M';
  const currentCol = hourVN < 12 ? 'P' : 'Q';
  const currentLabel = hourVN < 12 ? 'hôm qua' : 'hôm nay';

  const allData = await getSaleComparisonData(token, prevCol, currentCol);
  if (!allData.length) return null; // để null thay vì chuỗi lỗi

  const topData = allData.filter(r =>
    r.warehouse === 'Binh Tan Warehouse' && String(r.avr7days).trim() !== ''
  );
  const totalData = allData.filter(r =>
    r.finalStatus === 'On sale' && r.warehouse === 'Binh Tan Warehouse' && String(r.avr7days).trim() !== ''
  );

  if (!topData.length) return 'Không có dữ liệu cho Warehouse: Binh Tan Warehouse';

  const totalIncrease = totalData.filter(r => r.change > 0).length;
  const totalDecrease = totalData.filter(r => r.change < 0).length;

  const increases = topData
    .filter(r => r.prev > 0 && r.current > 10 && (r.change >= 0 || r.change === Infinity))
    .sort((a,b) => (b.change === Infinity ? 1e12 : b.change) - (a.change === Infinity ? 1e12 : a.change))
    .slice(0,5);

  const decreases = topData
    .filter(r => r.prev > 10 && r.change < 0)
    .sort((a,b) => a.change - b.change)
    .slice(0,5);

  const allOOS = totalData
    .filter(r => Number(r.stock) === 0)
    .map(r => {
      let label = '';
      if (r.sale1day === 0 && r.sale2day === 0 && r.sale3day === 0) label = 'OOS > 3 ngày';
      else if (r.sale1day === 0 && r.sale2day === 0) label = 'OOS 2 ngày';
      else if (r.sale1day === 0) label = 'OOS 1 ngày';
      return { ...r, oosLabel: label };
    })
    .filter(r => r.oosLabel)
    .sort((a,b) => {
      const w = lbl => lbl.includes('> 3') ? 3 : lbl.includes('2') ? 2 : 1;
      return w(b.oosLabel) - w(a.oosLabel);
    });

  const outOfStock = allOOS.slice(0,5);

  let msg = `📊 Biến động Sale (WBT): AVG D-7 → ${currentLabel}:\n`;
  if (increases.length) {
    msg += `\n🔥 Top 5 tăng mạnh / Tổng ${totalIncrease} SKU tăng:\n`;
    increases.forEach(r => {
      const pct = r.change === Infinity ? '+∞%' : `+${r.change.toFixed(1)}%`;
      msg += `- ${r.productName}: ${r.prev} → ${r.current} (${pct})\n`;
    });
  }
  if (decreases.length) {
    msg += `\n📉 Top 5 giảm mạnh / Tổng ${totalDecrease} SKU giảm:\n`;
    decreases.forEach(r => { msg += `- ${r.productName}: ${r.prev} → ${r.current} (${r.change.toFixed(1)}%)\n`; });
  }
  if (outOfStock.length) {
    msg += `\n🚨 SKU hết hàng / Tổng ${allOOS.length} SKU OOS:\n`;
    outOfStock.forEach(r => { msg += `- ${r.productName} (${r.oosLabel})\n`; });
    if (allOOS.length > 5) msg += `... và ${allOOS.length - 5} SKU khác.\n`;
  }
  return msg;
}

// Hàm an toàn: thử lại 3 lần nếu chưa có dữ liệu
async function safeAnalyzeSalesChange(token) {
  let tries = 3;
  while (tries > 0) {
    const msg = await analyzeSalesChange(token);
    if (msg && typeof msg === "string") return msg; // có dữ liệu hợp lệ thì trả về
    console.log("⚠ Dữ liệu TOP 5/OOS chưa sẵn sàng, thử lại sau 1 phút...");
    await new Promise(r => setTimeout(r, 60000)); // chờ 1 phút
    tries--;
  }
  return "⚠ Dữ liệu vẫn chưa đủ để phân tích sau 3 lần thử.";
}

   
   async function getCellB2Value(token) {
     try {
       const targetColumn = 'G';
       const url = `${process.env.LARK_DOMAIN}/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${SHEET_ID}!${targetColumn}:${targetColumn}`;
       const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
       const values = resp.data.data.valueRange.values || [];
       const sum = values.reduce((acc, row) => {
         const v = row[0];
         const num = parseFloat((v ?? '').toString().replace(/,/g, ''));
         return isNaN(num) ? acc : acc + num;
       }, 0);
       return (sum || sum === 0) ? sum.toString() : null;
     } catch { return null; }
   }
   
   async function sendMessageToGroup(token, chatId, messageText) {
     try {
       const payload = { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: messageText }) };
       await axios.post(
         `${process.env.LARK_DOMAIN}/open-apis/im/v1/messages?receive_id_type=chat_id`,
         payload,
         { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
       );
     } catch (err) { console.log('Lỗi gửi tin nhắn:', err.message); }
   }
   
   async function checkB2ValueChange() {
     try {
       const token = await getAppAccessToken();
       const currentB2Value = await getCellB2Value(token);
       console.log('Đã đổ số:', { current: currentB2Value, last: lastB2Value });
   
       if (currentB2Value !== null && currentB2Value !== lastB2Value && lastB2Value !== null) {
         const messageText = `✅ Đã đổ Stock. Số lượng: ${currentB2Value} thùng`;
         for (const chatId of GROUP_CHAT_IDS) await sendMessageToGroup(token, chatId, messageText);
         const salesMsg = await analyzeSalesChange(token);
         if (salesMsg) for (const chatId of GROUP_CHAT_IDS) await sendMessageToGroup(token, chatId, salesMsg);
       }
       lastB2Value = currentB2Value;
     } catch (err) { console.log('Lỗi checkB2ValueChange:', err.message); }
   }
   
   /* =======================================================
      SECTION 11 — Conversation memory (short, rolling window)
      ======================================================= */
   function updateConversationMemory(chatId, role, content, senderName = null) {
     if (!conversationMemory.has(chatId)) conversationMemory.set(chatId, []);
     const mem = conversationMemory.get(chatId);
     mem.push({ role, content, senderName });
     if (mem.length > 20) mem.shift();
   }
   
   /* =======================================================
      SECTION 12 — Natural language → Sheet action (Plan)
      ======================================================= */
   async function interpretSheetQuery(userMessage, columnData) {
     try {
       const prompt = `
   Bạn là trợ lý phân tích bảng. Tôi cung cấp:
   1) Câu hỏi user: """${userMessage}"""
   2) Danh sách cột: ${JSON.stringify(Object.keys(columnData))}
   Chỉ trả về JSON:
   { "action": "value|sum|avg|percent_change|count", "target_column": "...", "match_column": "...", "match_value": "...", "note": "..." }
   `;
       const aiResp = await axios.post(
         'https://openrouter.ai/api/v1/chat/completions',
         {
           model: 'deepseek/deepseek-r1-0528:free',
           messages: [
             { role: 'system', content: 'Bạn là trợ lý AI chọn đúng cột từ header để tính nhanh.' },
             { role: 'user', content: prompt }
           ],
           stream: false
         },
         { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
       );
   
       const aiContent = aiResp.data?.choices?.[0]?.message?.content?.trim();
       if (!aiContent) return null;
       try { return JSON.parse(aiContent); }
       catch {
         const m = aiContent.match(/\{[\s\S]*\}/);
         if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
         return null;
       }
     } catch (err) {
       console.log('Lỗi interpretSheetQuery:', err.message);
       return null;
     }
   }
   
   async function processPlanQuery(messageId, spreadsheetToken, userMessage, token, mentionUserId, mentionUserName) {
     try {
       const sheetData = await getSheetData(spreadsheetToken, token, 'A:AL');
       if (!sheetData || !sheetData.length) {
         await replyToLark(messageId, 'Không có dữ liệu.', mentionUserId, mentionUserName);
         return;
       }
       const headers = sheetData[0].map(h => (h ? h.toString().trim() : ''));
       const rows = sheetData.slice(1).map(r => r.map(c => (c == null ? '' : c.toString().trim())));
       const headerToIndex = {}; headers.forEach((h,i)=> headerToIndex[h]=i);
       const columnData = {}; headers.forEach((h,idx)=> columnData[h || `Column_${idx}`] = rows.map(r => r[idx] || ''));
   
       const interpretation = await interpretSheetQuery(userMessage, columnData);
       if (!interpretation || !interpretation.action || !interpretation.target_column) {
         await replyToLark(messageId, 'Câu chưa rõ. Ví dụ: "Plan, hôm nay bán bao nhiêu thùng Lager".', mentionUserId, mentionUserName);
         return;
       }
   
       const tcol = interpretation.target_column;
       let targetColIdx = /^[A-Z]+$/.test(tcol) ? colToIndex(tcol) : headerToIndex[tcol];
       const mcol = interpretation.match_column;
       let matchColIdx = mcol ? (/^[A-Z]+$/.test(mcol) ? colToIndex(mcol) : headerToIndex[mcol]) : null;
       const matchValue = interpretation.match_value;
       const action = interpretation.action;
   
       const parseNum = v => {
         if (v === '' || v == null) return NaN;
         const cleaned = v.toString().replace(/[^\d.\-]/g, '');
         const n = parseFloat(cleaned);
         return isNaN(n) ? NaN : n;
       };
   
       let resultText = '';
       if (action === 'value') {
         if (matchColIdx == null || matchValue == null) resultText = 'Thiếu điều kiện lọc.';
         else if (targetColIdx == null) resultText = 'Không xác định cột.';
         else {
           const foundRow = rows.find(r =>
             (r[matchColIdx] || '').toLowerCase().includes(String(matchValue).toLowerCase())
           );
           resultText = foundRow
             ? `${headers[targetColIdx]} = ${foundRow[targetColIdx]}`
             : `Không tìm thấy "${matchValue}".`;
         }
       } else if (['sum','avg','count'].includes(action)) {
         if (targetColIdx == null) resultText = 'Không xác định cột.';
         else {
           let filtered = rows;
           if (matchColIdx != null && matchValue != null) {
             filtered = rows.filter(r => (r[matchColIdx] || '').toLowerCase().includes(String(matchValue).toLowerCase()));
           }
           const nums = filtered.map(r => parseNum(r[targetColIdx])).filter(n => !isNaN(n));
           if (!nums.length) resultText = 'Không có số liệu.';
           else {
             if (action === 'sum') resultText = `Tổng ${headers[targetColIdx]}: ${nums.reduce((a,b)=>a+b,0)}`;
             if (action === 'avg') resultText = `TB ${headers[targetColIdx]}: ${(nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(2)}`;
             if (action === 'count') resultText = `Số dòng: ${nums.length}`;
           }
         }
       } else {
         resultText = 'Không hỗ trợ.';
       }
   
       await replyToLark(messageId, resultText, mentionUserId, mentionUserName);
     } catch (err) {
       console.log('Lỗi processPlanQuery:', err.message);
       await replyToLark(messageId, 'Lỗi xử lý Plan.', mentionUserId, mentionUserName);
     } finally {
       pendingTasks.delete(messageId);
     }
   }
   
   /* =======================================================
      SECTION 13 — Bitable command handler (processBaseData)
      ======================================================= */
   async function processBaseData(messageId, baseId, tableId, userMessage, token) {
     try {
       // Lấy field meta + rows
       const fields = await getTableMeta(baseId, tableId, token);
       const fieldNameById = Object.fromEntries(fields.map(f => [f.field_id, f.name]));
       const items = await getAllRows(baseId, tableId, token);
   
       if (!items.length) {
         await replyToLark(messageId, 'Bảng trống.', null, null);
         return;
       }
   
       // Rất ngắn gọn: thống kê nhanh + 3 dòng mẫu
       const sample = items.slice(0, 3).map((it, idx) => {
         const kv = Object.entries(it.fields || {})
           .slice(0, 3)
           .map(([fid, val]) => `${fieldNameById[fid] || fid}: ${Array.isArray(val) ? JSON.stringify(val) : val}`)
           .join(' | ');
         return `${idx + 1}) ${kv}`;
       }).join('\n');
   
       const msg =
         `L-GPT: ${items.length} dòng.\n` +
         (sample ? `Mẫu:\n${sample}` : 'Không có mẫu.');
   
       await replyToLark(messageId, msg, null, null);
     } catch (err) {
       console.log('Lỗi processBaseData:', err.message);
       await replyToLark(messageId, 'Lỗi đọc Base.', null, null);
     } finally {
       pendingTasks.delete(messageId);
     }
   }
   
/* ===========================================
   SECTION 14 — Webhook (ONLY on @mention)
   =========================================== */
app.post('/webhook', async (req, res) => {
  try {
    const bodyRaw = req.body.toString('utf8');
    const signature = req.headers['x-lark-signature'];
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    if (!verifySignature(timestamp, nonce, bodyRaw, signature)) return res.sendStatus(401);

    let decryptedData = {};
    try { decryptedData = decryptMessage(JSON.parse(bodyRaw).encrypt || ''); } catch {}

    /* ---- Log khi BOT được thêm vào nhóm ---- */
    if (decryptedData.header?.event_type === 'im.chat.member.bot.added_v1') {
      const chatIdAdded = decryptedData.event?.chat_id;
      console.log(`🚀 BOT vừa được thêm vào nhóm, chatId: ${chatIdAdded}`);
      return res.sendStatus(200);
    }

    if (decryptedData.header?.event_type === 'im.message.receive_v1') {
      const message = decryptedData.event.message;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const chatType = message.chat_type;
      const messageType = message.message_type;
      const senderId = decryptedData.event.sender.sender_id.open_id;
      const mentions = message.mentions || [];

      // idempotent
      if (processedMessageIds.has(messageId)) return res.sendStatus(200);
      processedMessageIds.add(messageId);

      // Bỏ phản hồi chính mình
      if (senderId === (process.env.BOT_SENDER_ID || '')) return res.sendStatus(200);

      // Kiểm tra bot có bị mention
      const botMentioned = mentions.some(m =>
        (m.id?.open_id && m.id.open_id === BOT_OPEN_ID) ||
        (m.id?.app_id && m.id.app_id === process.env.LARK_APP_ID)
      );

      // Nếu trong group và mention bot → in log chatId
      if (chatType === 'group' && botMentioned) {
        console.log(`💬 Tin nhắn mention BOT trong group: ${chatId}`);
      }

      // Nếu group mà không mention bot thì bỏ qua
      if (chatType === 'group' && !botMentioned) return res.sendStatus(200);

      // OK trả 200 sớm
      res.sendStatus(200);

      // Lấy token
      const token = await getAppAccessToken();

      // Luôn tag lại người gửi khi trả lời
      const mentionUserId = senderId;
      const mentionUserName = await getUserInfo(senderId, token);

      // Lấy text sau khi bỏ <at>
      let textAfterMention = '';
      try {
        const raw = JSON.parse(message.content).text || '';
        textAfterMention = raw.replace(/<at.*?<\/at>/g, '').trim();
      } catch { textAfterMention = ''; }

      /* ---- Branch A: Plan ---- */
      if (/^Plan[,，]/i.test(textAfterMention)) {
        await processPlanQuery(messageId, SPREADSHEET_TOKEN, textAfterMention, token, mentionUserId, mentionUserName);
        return;
      }

      /* ---- Branch B: Base ---- */
      let baseId = '', tableId = '';
      const keyRegex = new RegExp(`^(${Object.keys(BASE_MAPPINGS).join('|')})(,|，)`, 'i');
      const reportMatch = textAfterMention.match(keyRegex);
      if (reportMatch) {
        const reportName = reportMatch[1].toUpperCase();
        const reportUrl = BASE_MAPPINGS[reportName];
        if (reportUrl) {
          const urlMatch = reportUrl.match(/base\/([a-zA-Z0-9]+)\?.*table=([a-zA-Z0-9]+)/);
          if (urlMatch) { baseId = urlMatch[1]; tableId = urlMatch[2]; }
        }
      }
      if (baseId && tableId) {
        await processBaseData(messageId, baseId, tableId, textAfterMention, token);
        return;
      }

      /* ---- Branch C: File/Image receive ---- */
      if (['file', 'image'].includes(messageType)) {
        try {
          const fileKey = message.file_key;
          if (!fileKey) {
            await replyToLark(messageId, 'Thiếu file_key.', mentionUserId, mentionUserName);
            return;
          }
          const fileName = message.file_name || `${messageId}.${messageType === 'image' ? 'jpg' : 'bin'}`;
          const ext = path.extname(fileName).slice(1).toLowerCase();
          pendingFiles.set(chatId, { fileKey, fileName, ext, messageId, timestamp: Date.now() });
          await replyToLark(messageId, 'Đã nhận file. Reply kèm yêu cầu trong 5 phút.', mentionUserId, mentionUserName);
        } catch (err) {
          await replyToLark(messageId, 'Lỗi nhận file.', mentionUserId, mentionUserName);
        }
        return;
      }

      /* ---- Branch D: Reply vào file ---- */
      if (messageType === 'post' && message.parent_id) {
        const pendingFile = pendingFiles.get(chatId);
        if (pendingFile && pendingFile.messageId === message.parent_id) {
          try {
            const fileUrlResp = await axios.get(
              `${process.env.LARK_DOMAIN}/open-apis/im/v1/files/${pendingFile.fileKey}/download_url`,
              { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
            );
            const fileUrl = fileUrlResp.data.data.download_url;
            const extractedText = await extractFileContent(fileUrl, pendingFile.ext);
            if (!extractedText || extractedText.startsWith('Lỗi')) {
              await replyToLark(messageId, `Không trích xuất được nội dung ${pendingFile.fileName}.`, mentionUserId, mentionUserName);
            } else {
              const combined = (textAfterMention || '') + `\nNội dung file: ${extractedText}`;
              updateConversationMemory(chatId, 'user', combined, mentionUserName);
              const memory = conversationMemory.get(chatId) || [];
              const formattedHistory = memory.map(m => (
                m.role === 'user'
                  ? { role: 'user', content: `${m.senderName || 'User'}: ${m.content}` }
                  : { role: 'assistant', content: `L-GPT: ${m.content}` }
              ));

              const aiResp = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                  model: 'deepseek/deepseek-r1-0528:free',
                  messages: [
                    { role: 'system', content: 'Bạn là L-GPT: lạnh lùng, ngắn gọn, súc tích.' },
                    ...formattedHistory,
                    { role: 'user', content: `${mentionUserName}: ${combined}` }
                  ],
                  stream: false
                },
                { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
              );
              const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Không có kết quả.';
              const clean = assistantMessage.replace(/[\*_`~]/g, '').trim();
              updateConversationMemory(chatId, 'assistant', clean, 'L-GPT');
              await replyToLark(messageId, clean, mentionUserId, mentionUserName);
            }
            pendingFiles.delete(chatId);
          } catch {
            await replyToLark(messageId, 'Lỗi xử lý file.', mentionUserId, mentionUserName);
            pendingFiles.delete(chatId);
          }
        } else {
          await replyToLark(messageId, 'Hãy reply trực tiếp vào tin chứa file.', mentionUserId, mentionUserName);
        }
        return;
      }

      /* ---- Branch E: Chat AI (text) ---- */
      if (messageType === 'text') {
        if (!textAfterMention) return;

        try {
          updateConversationMemory(chatId, 'user', textAfterMention, mentionUserName);
          const memory = conversationMemory.get(chatId) || [];
          const formattedHistory = memory.map(m => (
            m.role === 'user'
              ? { role: 'user', content: `${m.senderName || 'User'}: ${m.content}` }
              : { role: 'assistant', content: `L-GPT: ${m.content}` }
          ));

          const aiResp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'deepseek/deepseek-r1-0528:free',
              messages: [
                { role: 'system', content: 'Bạn là L-GPT: lạnh lùng, ngắn gọn, súc tích.' },
                ...formattedHistory,
                { role: 'user', content: `${mentionUserName}: ${textAfterMention}` }
              ],
              stream: false
            },
            { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
          );

          const assistantMessage = aiResp.data.choices?.[0]?.message?.content || 'Không có kết quả.';
          const cleanMessage = assistantMessage.replace(/[\*_`~]/g, '').trim();
          updateConversationMemory(chatId, 'assistant', cleanMessage, 'L-GPT');
          await replyToLark(messageId, cleanMessage, mentionUserId, mentionUserName);
        } catch {
          await replyToLark(messageId, 'Lỗi.', mentionUserId, mentionUserName);
        }
        return;
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    return res.sendStatus(500);
  }
});

   
   /* ===========================================
      SECTION 15 — Housekeeping & Schedules
      =========================================== */
   process.on('SIGTERM', () => {
     pendingTasks.forEach((task, messageId) =>
       replyToLark(messageId, 'Xử lý bị gián đoạn.', task.mentionUserId, task.mentionUserName)
     );
     process.exit(0);
   });
   
   setInterval(() => { conversationMemory.clear(); }, 2 * 60 * 60 * 1000);
   
   setInterval(() => {
     const now = Date.now();
     for (const [chatId, file] of pendingFiles) {
       if (now - file.timestamp > 5 * 60 * 1000) pendingFiles.delete(chatId);
     }
   }, 60 * 1000);
   
   /* ===========================================
      SECTION 16 — Start server + stock watcher
      =========================================== */
   app.listen(port, () => {
     checkB2ValueChange();
     setInterval(checkB2ValueChange, 60 * 1000);
     console.log(`L-GPT server listening on :${port}`);
   });
