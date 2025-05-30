require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(bodyParser.json());

app.post('/webhook', (req, res) => {
  const verifyToken = req.headers['x-lark-verify-token'] || req.headers['X-Lark-Request-Verification-Token'];

  console.log('Received verify token:', verifyToken);

  if (!verifyToken || verifyToken !== process.env.LARK_VERIFICATION_TOKEN) {
    console.log('[❌] Invalid verify token:', verifyToken);
    return res.status(401).send('Invalid verify token');
  }

  console.log('[✅] Valid verify token');
  
  // Xử lý event từ Lark ở đây

  res.status(200).send('ok');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
