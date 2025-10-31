import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import twilio from "twilio";
import { SpeechClient } from "@google-cloud/speech";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || "https://ai-voice-server-t4l5.onrender.com";

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* ========== GOOGLE SPEECH CLIENT ========== */
const credsPath = "/tmp/google-creds.json";
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  fs.writeFileSync(credsPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath;
}
const speechClient = new SpeechClient();

/* ========== AUDIO FOLDER ========== */
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(audioDir, { recursive: true });
app.use("/audio", express.static(audioDir));

/* ========== TTS ELEVENLABS ========== */
async function ttsElevenLabs(text) {
  const voiceId = "UgBBYS2sOqTuMpoF3BR0";
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: "eleven_v3",
      text,
      voice_settings: { stability: 0.6, similarity_boost: 0.8 },
    }),
  });

  const buffer = Buffer.from(await resp.arrayBuffer());
  const filename = `tts_${Date.now()}.mp3`;
  const filePath = path.join(audioDir, filename);
  fs.writeFileSync(filePath, buffer);
  return `${BASE_URL}/audio/${filename}`;
}

/* ========== START CALL (TwiML) ========== */
app.post("/api/phone/twiml", async (req, res) => {
  const greet = await ttsElevenLabs("שלום! אני העוזרת הקולית שלך. דבר איתי חופשי, אני מאזינה עכשיו.");
  const xml = `
<Response>
  <Play>${greet}</Play>
  <Connect>
    <Stream url="wss://${req.headers.host}/media" />
  </Connect>
</Response>`;
  res.type("text/xml").send(xml);
});

/* ========== TWILIO WS STREAM ========== */
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🎧 Twilio stream connected");

  const recognizeStream = speechClient
    .streamingRecognize({
      config: {
        encoding: "MULAW",
        sampleRateHertz: 8000,
        languageCode: "he-IL",
        enableAutomaticPunctuation: true,
        interimResults: true,
      },
      interimResults: true,
    })
    .on("data", async (data) => {
      const result = data.results[0];
      if (!result) return;
      const transcript = result.alternatives[0].transcript.trim();
      if (!transcript) return;

      if (result.isFinal) {
        console.log("🗣️ User:", transcript);
        const reply = await generateReply(transcript);
        const ttsUrl = await ttsElevenLabs(reply);
        await playAudioOverTwilio(ttsUrl);
        console.log("🤖 Replied:", reply);
      } else {
        process.stdout.write(`💬 ${transcript}\r`);
      }
    })
    .on("error", (err) => console.error("Google STT error:", err));

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "media") {
      const audioChunk = Buffer.from(data.media.payload, "base64");
      recognizeStream.write(audioChunk);
    }
    if (data.event === "stop") {
      recognizeStream.end();
      ws.close();
    }
  });

  ws.on("close", () => {
    recognizeStream.end();
    console.log("🔚 WS closed");
  });
});

/* ========== GPT REPLY ========== */
async function generateReply(text) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "אתה עוזר קולי מדבר עברית קצר וברור." },
        { role: "user", content: text },
      ],
    }),
  });

  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "לא הבנתי.";
}

/* ========== PLAY AUDIO LIVE ========== */
async function playAudioOverTwilio(url) {
  try {
    // אתה יכול לשמור כאן את ה־callSid אם אתה רוצה לעדכן את השיחה עצמה
    console.log("🔊 Playing back:", url);
  } catch (err) {
    console.error("❌ Playback error:", err.message);
  }
}

/* ========== SERVER ========== */
const server = app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});
