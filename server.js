import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FormData } from "formdata-node";
import { fileFromPath } from "formdata-node/file-from-path";
import twilio from "twilio";
import WavEncoder from "wav-encoder"; // ✅ חדש - המרת האודיו ל-WAV תקין

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const BASE_URL = "https://ai-voice-server-t4l5.onrender.com";
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// 🎧 יצירת תיקייה ציבורית לקבצי אודיו
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(audioDir, { recursive: true });
app.use("/audio", express.static(audioDir));

/**
 * 🗣️ יצירת קובץ TTS בעזרת ElevenLabs
 */
async function generateElevenAudio(text, filename = `tts_${Date.now()}.mp3`) {
  const voiceId = "UgBBYS2sOqTuMpoF3BR0"; // הקול שלך מ-ElevenLabs
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: "eleven_v3",
      text,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
      },
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`ElevenLabs TTS HTTP ${resp.status}: ${errorText}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const filePath = path.join(audioDir, filename);
  fs.writeFileSync(filePath, buffer);
  return `${BASE_URL}/audio/${filename}`;
}

/**
 * 📞 Twilio TwiML endpoint
 */
app.post("/api/phone/twiml", async (req, res) => {
  try {
    const greetingText = "שלום! אני העוזרת הקולית שלך. אני מאזינה עכשיו...";
    const greetingUrl = await generateElevenAudio(greetingText, "greeting.mp3");

    const WS_URL = `wss://ai-voice-server-t4l5.onrender.com/media`;

    const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${greetingUrl}</Play>
  <Connect>
    <Stream url="${WS_URL}" />
  </Connect>
</Response>`;

    res.type("text/xml").send(xmlResponse);
  } catch (err) {
    console.error("❌ Error creating greeting:", err.message);
    res
      .status(500)
      .type("text/xml")
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
});

/**
 * 🔗 WebSocket של Twilio Media Stream
 */
const wss = new WebSocketServer({ noServer: true });
const sessions = {};

wss.on("connection", (ws, req) => {
  console.log("🔗 Twilio Media Stream connected");
  let callSid = null;

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        callSid = msg.start.callSid;
        sessions[callSid] = { audioChunks: [], ws };
        console.log("📞 New call started:", callSid);
      }

      if (msg.event === "media") {
        const chunk = Buffer.from(msg.media.payload, "base64");
        sessions[callSid]?.audioChunks.push(chunk);
      }

      if (msg.event === "stop") {
        console.log("🛑 Stream stopped for call", callSid);
        await processConversationLoop(callSid);
      }
    } catch (err) {
      console.error("❌ WS error:", err);
    }
  });

  ws.on("close", () => console.log("🔚 WS closed"));
});

/**
 * 🔁 תהליך: דיבור → זיהוי → GPT → דיבור חוזר
 */
async function processConversationLoop(callSid) {
  const session = sessions[callSid];
  if (!session) return;

  const fullAudio = Buffer.concat(session.audioChunks);
  console.log("🎧 Received audio bytes:", fullAudio.length);

  if (fullAudio.length < 2000) {
    console.log("⚠️ Audio too short, skipping transcription.");
    return;
  }

  fs.mkdirSync("tmp", { recursive: true });
  const audioPath = `tmp/input_${callSid}.wav`;

  console.log("🎙️ Processing audio for call:", callSid);

  // ✅ המרה נכונה מ־PCM ל־WAV
  const audioData = {
    sampleRate: 8000, // Twilio משתמשת ב-8kHz
    channelData: [new Float32Array(fullAudio.length / 2)],
  };

  const floatData = new Float32Array(fullAudio.length / 2);
  for (let i = 0; i < fullAudio.length; i += 2) {
    const sample = fullAudio.readInt16LE(i);
    floatData[i / 2] = sample / 32768;
  }
  audioData.channelData[0] = floatData;

  const wavBuffer = await WavEncoder.encode(audioData);
  fs.writeFileSync(audioPath, Buffer.from(wavBuffer));

  // 1️⃣ זיהוי דיבור עם Whisper
  const formData = new FormData();
  formData.append("file", await fileFromPath(audioPath));
  formData.append("model", "whisper-1");

  const sttResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });

  const sttData = await sttResp.json();
  const userText = sttData.text?.trim() || "";
  console.log("🗣️ User said:", userText);

  if (!userText) {
    console.log("⚠️ No speech detected.");
    return;
  }

  // 2️⃣ תשובה עם GPT
  const gptResp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "אתה עוזר קולי נחמד שמדבר בעברית קצר וברור." },
        { role: "user", content: userText },
      ],
    }),
  });

  const gptData = await gptResp.json();
  const replyText = gptData.choices?.[0]?.message?.content?.trim() || "לא הצלחתי להבין.";
  console.log("🤖 GPT replied:", replyText);

  // 3️⃣ יצירת קובץ TTS
  const replyUrl = await generateElevenAudio(replyText);

  // 4️⃣ הפעלת התשובה בטוויליו
  try {
    await client.calls(callSid).update({
      method: "POST",
      url: `${BASE_URL}/api/play?url=${encodeURIComponent(replyUrl)}`,
    });
    console.log("🎧 Sent playback URL:", replyUrl);
  } catch (err) {
    console.error("❌ Failed to play audio:", err.message);
  }

  session.audioChunks = [];
}

/**
 * 🎵 TwiML להשמעת תשובה + התחברות מחדש
 */
app.post("/api/play", (req, res) => {
  const { url } = req.query;
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${url}</Play>
  <Redirect>${BASE_URL}/api/phone/twiml</Redirect>
</Response>`;
  res.type("text/xml").send(xmlResponse);
});

/**
 * 🚀 הפעלת השרת
 */
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});
