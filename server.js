import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import twilio from "twilio";
import speech from "@google-cloud/speech";

dotenv.config();

// ⚙️ הגדרות בסיסיות
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const BASE_URL = "https://ai-voice-server-t4l5.onrender.com";

// ✅ בדיקה למפתח של Google
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  console.error("❌ Missing GOOGLE_APPLICATION_CREDENTIALS_JSON env variable!");
  process.exit(1);
}

// 🎧 יצירת לקוח Google STT
const speechClient = new speech.SpeechClient({
  credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// תיקייה ציבורית לקבצי אודיו
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(audioDir, { recursive: true });
app.use("/audio", express.static(audioDir));

/** 🗣️ פונקציית דיבור מ-ElevenLabs */
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
      model_id: "eleven_v3",
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`ElevenLabs HTTP ${resp.status}: ${errorText}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const filePath = path.join(audioDir, filename);
  fs.writeFileSync(filePath, buffer);
  return `${BASE_URL}/audio/${filename}`;
}

/** 📞 Twilio TwiML Greeting */
app.post("/api/phone/twiml", async (req, res) => {
  try {
    const greetingText = "שלום! אני העוזרת הקולית שלך. איך אפשר לעזור?";
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
    res.status(500).type("text/xml")
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
});

/** 🔗 WebSocket של Twilio + Google STT בזמן אמת */
const wss = new WebSocketServer({ noServer: true });
const sessions = {};

wss.on("connection", (ws, req) => {
  console.log("🔗 Twilio Media Stream connected");
  let callSid = null;

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === "start") {
      callSid = msg.start.callSid;
      console.log("📞 New call started:", callSid);

      // 🎙️ פתיחת stream ל-Google Speech
      const recognizeStream = speechClient
        .streamingRecognize({
          config: {
            encoding: "LINEAR16",
            sampleRateHertz: 8000,
            languageCode: "he-IL",
          },
          interimResults: true,
        })
        .on("error", (err) => console.error("STT error:", err))
        .on("data", async (data) => {
          const text = data.results
            .map((r) => r.alternatives[0].transcript)
            .join(" ")
            .trim();

          if (text) {
            console.log("🗣️ User said:", text);

            // 🤖 שליחת השאלה ל-GPT
            const gptResp = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                  { role: "system", content: "אתה עוזר קולי שמדבר עברית קצר וברור." },
                  { role: "user", content: text },
                ],
              }),
            });

            const gptData = await gptResp.json();
            const reply =
              gptData.choices?.[0]?.message?.content?.trim() || "לא הבנתי אותך.";

            console.log("🤖 GPT replied:", reply);

            // 🎧 הפקת קול מ-ElevenLabs
            const replyUrl = await generateElevenAudio(reply);

            // 📞 השמעה למשתמש
            await client.calls(callSid).update({
              method: "POST",
              url: `${BASE_URL}/api/play?url=${encodeURIComponent(replyUrl)}`,
            });
          }
        });

      sessions[callSid] = { ws, recognizeStream };
    }

    if (msg.event === "media") {
      const audio = Buffer.from(msg.media.payload, "base64");
      const session = sessions[callSid];
      if (session?.recognizeStream) session.recognizeStream.write(audio);
    }

    if (msg.event === "stop") {
      console.log("🛑 Stream stopped for call", callSid);
      const session = sessions[callSid];
      if (session?.recognizeStream) session.recognizeStream.end();
    }
  });

  ws.on("close", () => console.log("🔚 WS closed"));
});

/** 🎧 TwiML להשמעת תשובה */
app.post("/api/play", (req, res) => {
  const { url } = req.query;
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${url}</Play>
  <Redirect>${BASE_URL}/api/phone/twiml</Redirect>
</Response>`;
  res.type("text/xml").send(xmlResponse);
});

/** 🚀 הפעלת השרת */
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
