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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
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
 * 🔁 פונקציה שממירה PCM raw ל-WAV תקין
 */
function pcmToWav(buffer, filename, sampleRate = 8000) {
  const header = Buffer.alloc(44);
  const fileSize = 44 + buffer.length - 8;

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // ByteRate = SampleRate * NumChannels * BitsPerSample/8
  header.writeUInt16LE(2, 32); // BlockAlign
  header.writeUInt16LE(16, 34); // BitsPerSample
  header.write("data", 36);
  header.writeUInt32LE(buffer.length, 40);

  const wavBuffer = Buffer.concat([header, buffer]);
  fs.writeFileSync(filename, wavBuffer);
}

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

  // המרה ל-WAV תקין
  pcmToWav(fullAudio, audioPath);

  console.log("🎙️ Processing audio for call:", callSid);

  // 1️⃣ Whisper STT
  const formData = new FormData();
  formData.append("file", await fileFromPath(audioPath));
  formData.append("model", "whisper-1");
  formData.append("language", "he");

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
    session.audioChunks = [];
    return;
  }

  // 2️⃣ GPT response
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
  const replyText =
    gptData.choices?.[0]?.message?.content?.trim() || "לא הצלחתי להבין.";
  console.log("🤖 GPT replied:", replyText);

  // 3️⃣ ElevenLabs TTS
  let replyUrl;
  try {
    replyUrl = await generateElevenAudio(replyText);
  } catch (err) {
    console.error("❌ ElevenLabs TTS failed:", err.message);
    session.audioChunks = [];
    return;
  }

  // 4️⃣ Play reply
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
 * 🎵 TwiML endpoint להשמעת תשובה + התחברות מחדש
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
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req)
    );
  } else socket.destroy();
});
