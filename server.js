import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FormData } from "formdata-node";
import { fileFromPath } from "formdata-node/file-from-path";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const BASE_URL = process.env.BASE_URL || "https://ai-voice-server-t4l5.onrender.com";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 🎧 תיקייה ציבורית לאודיו
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(audioDir, { recursive: true });
app.use("/audio", express.static(audioDir));

/**
 * 🗣️ יצירת אודיו TTS ב‑ElevenLabs והחזרתו כ‑Buffer
 */
async function generateElevenAudioBuffer(text) {
  const voiceId = "UgBBYS2sOqTuMpoF3BR0"; // הקול שלך ב‑ElevenLabs
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
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`ElevenLabs TTS HTTP ${resp.status}: ${errorText}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * 📞 Twilio TwiML endpoint
 */
app.post("/api/phone/twiml", async (req, res) => {
  try {
    const greetingText = "שלום! אני העוזרת הקולית שלך. אני מאזינה עכשיו...";
    const greetingBuffer = await generateElevenAudioBuffer(greetingText);
    const greetingFile = path.join(audioDir, `greeting_${Date.now()}.mp3`);
    fs.writeFileSync(greetingFile, greetingBuffer);

    const WS_URL = `wss://${BASE_URL.replace(/^https?:\/\//, "")}/media`;

    const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${BASE_URL}/audio/${path.basename(greetingFile)}</Play>
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

      // התחלת שיחה
      if (msg.event === "start") {
        callSid = msg.start.callSid;
        sessions[callSid] = { audioChunks: [], ws };
        console.log("📞 New call started:", callSid);
      }

      // קבלת אודיו מהמשתמש
      if (msg.event === "media") {
        const chunk = Buffer.from(msg.media.payload, "base64");
        sessions[callSid]?.audioChunks.push(chunk);
      }

      // אחרי כל קטע של דיבור (אפשר גם לפי זמן/גודל)
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
 * 🔁 תהליך דיבור → STT → GPT → TTS → שליחה בזמן אמת ל‑Twilio
 */
async function processConversationLoop(callSid) {
  const session = sessions[callSid];
  if (!session) return;

  const fullAudio = Buffer.concat(session.audioChunks);
  if (fullAudio.length < 2000) {
    console.log("⚠️ Audio too short, skipping transcription.");
    return;
  }

  // שמירת WAV זמני
  fs.mkdirSync("tmp", { recursive: true });
  const audioPath = `tmp/input_${callSid}.wav`;
  fs.writeFileSync(audioPath, fullAudio);

  // 1️⃣ Whisper STT בעברית
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
  if (!userText) return;

  // 2️⃣ GPT response בעברית
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

  // 3️⃣ ElevenLabs TTS
  const replyBuffer = await generateElevenAudioBuffer(replyText);

  // 4️⃣ שליחה בזמן אמת ל‑Twilio
  const audioBase64 = replyBuffer.toString("base64");
  if (session.ws.readyState === 1) {
    session.ws.send(JSON.stringify({
      event: "media",
      media: { payload: audioBase64, type: "audio/mpeg" },
    }));
    console.log("🎧 Sent TTS to Twilio Media Stream");
  }

  // ניקוי לאודיו הבא
  session.audioChunks = [];
}

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
