import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import FormData from "form-data";
import twilio from "twilio";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// ✅ כתובת בסיס של השרת ב־Render
const BASE_URL = "https://ai-voice-server-t4l5.onrender.com";

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 📂 הגשת קבצי האודיו לציבור
app.use("/audio", express.static(path.join(__dirname, "public/audio")));

// 📞 TwiML ראשוני — השלב הראשון של השיחה
app.post("/api/phone/twiml", (req, res) => {
  const WS_URL = `wss://ai-voice-server-t4l5.onrender.com/media`;
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="he-IL" voice="Polly-Dalia">שלום! אני העוזרת הקולית שלך. אני מאזינה עכשיו...</Say>
  <Connect>
    <Stream url="${WS_URL}" />
  </Connect>
</Response>`;
  res.type("text/xml").send(xmlResponse);
});

// 🧠 WebSocket Server — תקשורת עם Twilio Media Stream
const wss = new WebSocketServer({ noServer: true });

// נשמור מצב לפי כל callSid כדי לאפשר לולאה
const sessions = {};

wss.on("connection", (ws, req) => {
  console.log("🔗 WebSocket connected");
  let callSid = null;
  let audioChunks = [];

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
      console.error("❌ WebSocket error:", err);
    }
  });

  ws.on("close", () => console.log("🔚 WS closed"));
});

// 🔁 פונקציה שמטפלת בלולאת השיחה
async function processConversationLoop(callSid) {
  const session = sessions[callSid];
  if (!session) return;

  const fullAudio = Buffer.concat(session.audioChunks);
  fs.mkdirSync("tmp", { recursive: true });
  const audioPath = `tmp/input_${callSid}.wav`;
  fs.writeFileSync(audioPath, fullAudio);

  console.log("🎙️ Processing audio for call:", callSid);

  // --- 1️⃣ Speech to Text ---
  const formData = new FormData();
  formData.append("file", fs.createReadStream(audioPath));
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
    console.log("⚠️ No speech detected, restarting stream...");
    await restartStream(callSid);
    return;
  }

  // --- 2️⃣ Generate GPT response ---
  const gptResp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "אתה עוזר קולי נחמד שמדבר עברית בשפה טבעית וקצרה." },
        { role: "user", content: userText },
      ],
    }),
  });

  const gptData = await gptResp.json();
  const replyText = gptData.choices?.[0]?.message?.content?.trim() || "לא הצלחתי להבין.";
  console.log("🤖 GPT replied:", replyText);

  // --- 3️⃣ Gemini TTS ---
  const ttsResp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro-preview-tts:generateSpeech?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text: replyText },
        voice: { name: "zephyr" },
        audioConfig: { audioEncoding: "MP3" },
      }),
    }
  );

  const ttsData = await ttsResp.json();
  if (!ttsData.audioContent) {
    console.error("❌ Gemini TTS failed:", ttsData);
    await restartStream(callSid);
    return;
  }

  const audioDir = path.join(__dirname, "public/audio");
  fs.mkdirSync(audioDir, { recursive: true });
  const ttsFile = `tts_${Date.now()}.mp3`;
  const ttsPath = path.join(audioDir, ttsFile);
  fs.writeFileSync(ttsPath, Buffer.from(ttsData.audioContent, "base64"));

  const publicUrl = `${BASE_URL}/audio/${ttsFile}`;
  console.log("🎧 TTS file ready:", publicUrl);

  // --- 4️⃣ Tell Twilio to play and loop ---
  await client.calls(callSid).update({
    method: "POST",
    url: `${BASE_URL}/api/play?url=${encodeURIComponent(publicUrl)}`,
  });

  // ננקה את הבאפר
  sessions[callSid].audioChunks = [];
}

// 🎵 TwiML לניגון הקובץ + חזרה ללולאה
app.post("/api/play", (req, res) => {
  const { url } = req.query;
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${url}</Play>
  <Redirect>${BASE_URL}/api/phone/twiml</Redirect>
</Response>`;
  res.type("text/xml").send(xmlResponse);
});

// 🔁 במקרה שאין קול או כשל — נבצע redirect כדי להאזין שוב
async function restartStream(callSid) {
  try {
    await client.calls(callSid).update({
      method: "POST",
      url: `${BASE_URL}/api/phone/twiml`,
    });
    console.log("🔁 Restarted stream for call:", callSid);
  } catch (err) {
    console.error("❌ restartStream error:", err.message);
  }
}

// 🚀 הפעלת השרת
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
  console.log(`📞 TwiML endpoint: ${BASE_URL}/api/phone/twiml`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req)
    );
  } else {
    socket.destroy();
  }
});
