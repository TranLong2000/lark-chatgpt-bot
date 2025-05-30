require('dotenv').config();
const fetch = require('node-fetch');

async function getTenantAccessToken() {
  const response = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET
    })
  });

  const data = await response.json();

  if (data.code !== 0) {
    console.error('[❌] Failed to get token:', data);
    return null;
  }

  console.log('[✅] Tenant Access Token:', data.tenant_access_token);
  return data.tenant_access_token;
}

getTenantAccessToken();
