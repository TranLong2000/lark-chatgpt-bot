// src/index.js
const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');

const {
  LARK_APP_ID,
  LARK_APP_SECRET,
  LARK_VERIFICATION_TOKEN,
  OPENAI_API_KEY,
} = process.env;

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
...
}
