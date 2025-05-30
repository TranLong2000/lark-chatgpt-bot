app.post('/webhook', (req, res) => {
  const verifyToken = req.headers['x-lark-verify-token'];

  console.log('[🔍] Received token:', verifyToken);

  if (verifyToken !== process.env.LARK_VERIFICATION_TOKEN) {
    console.log('[❌] Invalid verify token:', verifyToken);
    return res.status(401).send('Unauthorized');
  }

  console.log('[✅] Valid verify token');
  res.status(200).send('ok');
});
