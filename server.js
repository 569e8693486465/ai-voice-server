import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import WavEncoder from "wav-encoder";
import twilio from "twilio";
import { SpeechClient } from "@google-cloud/speech";
import VAD from "vad";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const BASE_URL = process.env.BASE_URL || "http://localhost:8080";

// 🔐 Google Credentials
const googleCredentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
const speechClient = new SpeechClient({ credentials: googleCredentials });

// Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// תיקיית אודיו ציבורית
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(audioDir, { recursive: true });

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use("/audio", express.static(audioDir));

// --- TTS ElevenLabs ---
async function generateElevenAudio(text, filename = `tts_${Date.now()}.mp3`) {
  const voiceId = "UgBBYS2sOqTuMpoF3BR0";
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });

  if (!resp.ok) {
    throw new Error(`ElevenLabs TTS error ${resp.status}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const filePath = path.join(audioDir, filename);
  fs.writeFileSync(filePath, buffer);
  return `${BASE_URL}/audio/${filename}`;
}

// --- GPT response ---
async function getAIResponse(text) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "אתה עוזר קולי נחמד שמדבר בעברית קצר וברור." },
        { role: "user", content: text },
      ],
    }),
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

// --- WebSocket + VAD + Google Streaming STT ---
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Twilio Media Stream connected");

  // init VAD
  const vad = new VAD(VAD.Mode.NORMAL);
  let audioBufferChunks = [];

  // init Google stream
  const recognizeStream = speechClient.streamingRecognize({
    config: { encoding: "LINEAR16", sampleRateHertz: 8000, languageCode: "he-IL" },
    interimResults: true,
  })
  .on("data", async (data) => {
    const transcript = data.results[0]?.alternatives[0]?.transcript || "";
    const isFinal = data.results[0]?.isFinal;

    if (isFinal && transcript) {
      console.log("🗣️ User:", transcript);

      const replyText = await getAIResponse(transcript);
      console.log("🤖 GPT:", replyText);

      const audioUrl = await generateElevenAudio(replyText);
      ws.send(JSON.stringify({ event: "play_audio", url: audioUrl }));
    }
  })
  .on("error", (err) => console.error("Google STT error:", err));

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "media" && data.media?.payload) {
      const chunk = Buffer.from(data.media.payload, "base64");
      
      // VAD detection
      const voiceState = vad.processAudio(chunk, 8000);
      if (voiceState === VAD.Event.VOICE) {
        recognizeStream.write(chunk);
      }
      // silence → ניתן לשלוח סיום stream או להתעלם
    } else if (data.event === "stop") {
      recognizeStream.end();
    }
  });

  ws.on("close", () => {
    recognizeStream.end();
    console.log("🔴 Twilio disconnected");
  });
});

// --- Twilio webhook ---
app.post("/call", (req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  response.connect().stream({ url: `${BASE_URL}/media` });
  res.type("text/xml").send(response.toString());
});

// --- server upgrade handler ---
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});
