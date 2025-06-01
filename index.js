import 'dotenv/config';
import axios from 'axios';

const apiKey = process.env.GEMINI_API_KEY;

async function callGemini(text) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText?key=${apiKey}`;
    
    const response = await axios.post(url, {
      prompt: { text },
      temperature: 0.7,
      candidateCount: 1,
      maxOutputTokens: 1024,
    });
    console.log("Response from Gemini:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error calling Gemini API:", error.response?.data || error.message);
  }
}

callGemini("Xin chào thế giới!");
