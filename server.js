import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import twilio from "twilio";
import WavEncoder from "wav-encoder";
import speech from "@google-cloud/speech";

dotenv.config();

// ⚙️ הגדרות בסיסיות
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || "https://ai-voice-server-t4l5.onrender.com";

// מפתחות API
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// 🧠 Google Credentials (JSON מלא במשתנה סביבה)
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  console.error("❌ Missing GOOGLE_APPLICATION_CREDENTIALS_JSON env variable!");
  process.exit(1);
}

// ✨ כתיבת האישורים לקובץ זמני
const googleCredentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
const tempCredsPath = "/tmp/google-creds.json";
fs.writeFileSync(tempCredsPath, JSON.stringify(googleCredentials));
process.env.GOOGLE_APPLICATION_CREDENTIALS = tempCredsPath;

// 🗣️ יצירת לקוח Google Speech-to-Text
const speechClient = new speech.SpeechClient({
  keyFilename: tempCredsPath,
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// 🎧 תיקייה ציבורית לקבצי אודיו
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(audioDir, { recursive: true });
app.use("/audio", express.static(audioDir));

/** 🎙️ פונקציה ליצירת דיבור עם ElevenLabs */
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

  const buffer = Buffer.from(await resp.arrayBuffer());
  const filePath = path.join(audioDir, filename);
  fs.writeFileSync(filePath, buffer);
  return `${BASE_URL}/audio/${filename}`;
}

/** 📞 Twilio TwiML Greeting */
app.post("/api/phone/twiml", async (req, res) => {
  try {
    const greetingText = "שלום! אני העוזרת הקולית שלך. איך אפשר לעזור?";
    const greetingUrl = await generateElevenAudio(greetingText, "greeting.mp3");
    const WS_URL = `${BASE_URL.replace("https", "wss")}/media`;

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

// 🔗 WebSocket של Twilio
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
        sessions[callSid] = { audioChunks: [], ws, processing: false };
        console.log("📞 New call started:", callSid);
      }

      if (msg.event === "media") {
        const chunk = Buffer.from(msg.media.payload, "base64");
        sessions[callSid]?.audioChunks.push(chunk);

        // כשיש מספיק אודיו – נשלח ל-STT
        if (sessions[callSid].audioChunks.length > 60 && !sessions[callSid].processing) {
          sessions[callSid].processing = true;
          await processConversationLoop(callSid);
          sessions[callSid].processing = false;
        }
      }

      if (msg.event === "stop") {
        console.log("🛑 Stream stopped for call", callSid);
      }
    } catch (err) {
      console.error("❌ WS error:", err);
    }
  });

  ws.on("close", () => console.log("🔚 WS closed"));
});

/** 🎧 עיבוד קלט קולי עם Google STT */
async function processConversationLoop(callSid) {
  const session = sessions[callSid];
  if (!session) return;

  const fullAudio = Buffer.concat(session.audioChunks);
  console.log("🎧 Received audio bytes:", fullAudio.length);

  if (fullAudio.length < 4000) {
    console.log("⚠️ Audio too short, skipping transcription.");
    return;
  }

  // יצירת WAV זמני (נדרש ל-Google STT)
  const tmpDir = path.join(__dirname, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const audioPath = path.join(tmpDir, `input_${callSid}.wav`);

  const floatData = new Float32Array(fullAudio.length / 2);
  for (let i = 0; i < fullAudio.length; i += 2) {
    const sample = fullAudio.readInt16LE(i);
    floatData[i / 2] = sample / 32768;
  }

  const audioData = {
    sampleRate: 8000,
    channelData: [floatData],
  };

  const wavBuffer = await WavEncoder.encode(audioData);
  fs.writeFileSync(audioPath, Buffer.from(wavBuffer));

  console.log("🎙️ Sending audio to Google STT...");

  const [sttResponse] = await speechClient.recognize({
    audio: { content: fs.readFileSync(audioPath).toString("base64") },
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 8000,
      languageCode: "he-IL",
    },
  });

  const userText = sttResponse.results?.map(r => r.alternatives[0].transcript).join(" ")?.trim();
  console.log("🗣️ User said:", userText || "(nothing)");

  if (!userText) return;

  // תשובה מ-GPT
  const gptResp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "אתה עוזר קולי חכם שמדבר עברית בצורה טבעית וקצרה." },
        { role: "user", content: userText },
      ],
    }),
  });

  const gptData = await gptResp.json();
  const replyText = gptData.choices?.[0]?.message?.content?.trim() || "לא הצלחתי להבין.";
  console.log("🤖 GPT replied:", replyText);

  const replyUrl = await generateElevenAudio(replyText);

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

/** 🔊 TwiML להשמעת תשובה */
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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});
