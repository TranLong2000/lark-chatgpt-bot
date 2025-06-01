import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import axios from 'axios';
import { OpenAI } from 'openai';

dotenv.config();

const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const PORT = process.env.PORT || 8080;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function logRequest(req) {
  console.log('--- New Webhook Request ---');
  console.log('URL:', req.originalUrl);
  console.log('Method:', req.method);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  try {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  } catch {
    console.log('Body: <cannot stringify>');
  }
}

function verifyLarkSignature(req) {
  try {
    const timestamp = req.headers['x-lark-request-timestamp'];
    const nonce = req.headers['x-lark-request-nonce'];
    const signature = req.headers['x-lark-signature'];

    if (!timestamp || !nonce || !signature) {
      console.error('[Verify] Missing headers');
      return false;
    }

    const payload = req.rawBody || '';
    const key = Buffer.from(process.env.LARK_ENCRYPT_KEY, 'base64');
    const str = `${timestamp}${nonce}${payload}`;

    const hmac = crypto.createHmac('sha256', key);
    hmac.update(str);
    const expected = hmac.digest('base64');

    if (expected !== signature) {
      console.error('[Verify] Signature mismatch');
      return false;
    }

    console.log('[Verify] Signature OK');
    return true;
  } catch (err) {
    console.error('[Verify] Error:', err.message);
    return false;
  }
}

function decryptEncryptKe
