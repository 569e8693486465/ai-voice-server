import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { FormData } from "formdata-node";
import { fileFromPath } from "formdata-node/file-from-path";
import twilio from "twilio";

dotenv.config();

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const BASE_URL = process.env.BASE_URL;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// תיקיות אודיו זמני
fs.mkdirSync(path.join("public/audio"), { recursive: true });
fs.mkdirSync(path.join("tmp"), { recursive: true });
app.use("/audio", express.static(path.join("public/audio")));

// 🗣️ ElevenLabs TTS
async function generateElevenAudio(text, filename = `tts_${Date.now()}.mp3`) {
  const voiceId = "UgBBYS2sOqTuMpoF3BR0"; 
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: "eleven_v3",
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });
  if (!resp.ok) throw new Error(`ElevenLabs TTS HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const filePath = path.join("public/audio", filename);
  fs.writeFileSync(filePath, buffer);
  return `${BASE_URL}/audio/${filename}`;
}

// זיכרון שיחות לפי callSid
const sessions = {};

// 📞 Twilio TwiML endpoint עם Media Stream
app.post("/api/phone/twiml", async (req, res) => {
  try {
    const greetingUrl = await generateElevenAudio("שלום! אני העוזרת הקולית שלך. אפשר לדבר עכשיו.");
    const WS_URL = `wss://${BASE_URL}/media`;

    const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${greetingUrl}</Play>
  <Connect>
    <Stream url="${WS_URL}" />
  </Connect>
</Response>`;
    res.type("text/xml").send(xmlResponse);
  } catch (err) {
    console.error(err);
    res.status(500).type("text/xml").send(`<Response><Hangup/></Response>`);
  }
});

// 🔗 WebSocket Server ל-Media Stream
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  let callSid = null;
  sessions[callSid] = { audioChunks: [] };

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        callSid = msg.start.callSid;
        sessions[callSid] = { audioChunks: [] };
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

// 🔁 Process Audio → STT → GPT → TTS → Play
async function processConversationLoop(callSid) {
  const session = sessions[callSid];
  if (!session || session.audioChunks.length === 0) return;

  const fullAudio = Buffer.concat(session.audioChunks);
  const audioPath = `tmp/input_${callSid}.wav`;
  fs.writeFileSync(audioPath, fullAudio);
  console.log("🎙️ Processing audio for call:", callSid);

  // Whisper STT
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
  if (!userText) return;

  // GPT
  const gptResp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "אתה עוזר קולי בעברית, נחמד ותמציתי." },
        { role: "user", content: userText },
      ],
    }),
  });

  const gptData = await gptResp.json();
  const replyText = gptData.choices?.[0]?.message?.content?.trim() || "לא הבנתי.";
  console.log("🤖 GPT replied:", replyText);

  // ElevenLabs TTS
  const replyUrl = await generateElevenAudio(replyText);

  // Play לתשובה דרך Twilio
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

// TwiML endpoint להשמעת TTS + Redirect
app.post("/api/play", (req, res) => {
  const { url } = req.query;
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${url}</Play>
  <Redirect>${BASE_URL}/api/phone/twiml</Redirect>
</Response>`;
  res.type("text/xml").send(xmlResponse);
});

// 🚀 Start server
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req)
    );
  } else socket.destroy();
});
