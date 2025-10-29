import express from "express";
import bodyParser from "body-parser";
import WebSocket, { WebSocketServer } from "ws";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import FormData from "formdata-node"; // החלפה במקום form-data הישן
import { fileFromSync } from "formdata-node/file-from-path"; // לעבודה עם קבצים ב-FormData

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const WS_URL = process.env.WS_URL || "wss://ai-voice-server-t4l5.onrender.com/api/phone/ws";
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let sessions = {};

// 🧠 פונקציה ליצירת Greeting עם ElevenLabs
async function generateGreetingTTS(text) {
  try {
    const response = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/UgBBYS2sOqTuMpoF3BR0/stream",
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVEN_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_v3",
          voice_settings: {
            stability: 0.7,
            similarity_boost: 0.8,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs TTS HTTP ${response.status}: ${errorText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync("public", { recursive: true });
    const outputFile = path.join("public", "greeting.wav");
    fs.writeFileSync(outputFile, buffer);
    return `https://ai-voice-server-t4l5.onrender.com/${outputFile}`;
  } catch (err) {
    console.error("❌ Error creating greeting:", err.message);
    return null;
  }
}

// 🧩 TwiML – מה שטוויליו מקבל כשמגיעה שיחה
app.post("/api/phone/twiml", async (req, res) => {
  const greetingUrl = await generateGreetingTTS("שלום! אני העוזר הקולי שלך. איך אפשר לעזור?");
  const twiml = `
    <Response>
      ${greetingUrl ? `<Play>${greetingUrl}</Play>` : ""}
      <Connect>
        <Stream url="${WS_URL}" track="inbound_track" />
      </Connect>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml);
});

// 🎧 WebSocket – סטרים בזמן אמת
app.ws = (path, handler) => {
  const wss = new WebSocketServer({ noServer: true });
  app.on("upgrade", (req, socket, head) => {
    if (req.url === path) {
      wss.handleUpgrade(req, socket, head, (ws) => handler(ws, req));
    }
  });
};

app.ws("/api/phone/ws", (ws) => {
  let callSid = null;
  ws.on("message", async (msgRaw) => {
    const msg = JSON.parse(msgRaw);

    // התחברות לשיחה
    if (msg.event === "start") {
      callSid = msg.start.callSid;
      console.log("📞 New call started:", callSid);
      sessions[callSid] = { audioChunks: [] };
    }

    // קבלת מדיה (Base64)
    if (msg.event === "media") {
      const chunk = Buffer.from(msg.media.payload, "base64");
      sessions[callSid]?.audioChunks.push(chunk);
    }

    // סוף סטרים → עיבוד
    if (msg.event === "stop") {
      console.log("🛑 Stream stopped for call", callSid);

      const session = sessions[callSid];
      if (!session || session.audioChunks.length === 0) {
        console.warn("⚠️ No audio data received for", callSid);
        return;
      }

      const fullAudio = Buffer.concat(session.audioChunks);
      const wavHeader = Buffer.from([
        0x52, 0x49, 0x46, 0x46,
        ...Array(4).fill(0),
        0x57, 0x41, 0x56, 0x45,
        0x66, 0x6d, 0x74, 0x20,
        16, 0, 0, 0,
        1, 0,
        1, 0,
        0x40, 0x1f, 0, 0,
        0x40, 0x1f, 0, 0,
        1, 0,
        8, 0,
        0x64, 0x61, 0x74, 0x61,
        ...Array(4).fill(0),
      ]);
      wavHeader.writeUInt32LE(fullAudio.length, 40);
      wavHeader.writeUInt32LE(fullAudio.length + 36, 4);

      const fullWav = Buffer.concat([wavHeader, fullAudio]);
      fs.mkdirSync("tmp", { recursive: true });
      const wavPath = `tmp/input_${callSid}.wav`;
      fs.writeFileSync(wavPath, fullWav);
      console.log("🎧 Saved WAV file:", wavPath);

      // שלב STT (OpenAI Whisper)
      const transcript = await transcribeAudio(wavPath);
      console.log("🗣️ User said:", transcript);

      if (transcript && transcript.trim().length > 0) {
        const aiReply = await getAIResponse(transcript);
        console.log("🤖 AI replied:", aiReply);

        const replyUrl = await generateGreetingTTS(aiReply);
        if (replyUrl) console.log("🎧 Sent playback URL:", replyUrl);
      } else {
        console.warn("⚠️ No speech detected.");
      }

      ws.close();
      delete sessions[callSid];
    }
  });
});

// 🧠 פונקציה ל־STT (OpenAI Whisper)
async function transcribeAudio(filePath) {
  try {
    const form = new FormData();
    form.set("file", fileFromSync(filePath));
    form.set("model", "whisper-1");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    const data = await response.json();
    return data.text || "";
  } catch (err) {
    console.error("❌ Error in STT:", err.message);
    return "";
  }
}

// 💬 פונקציה לשיחה עם GPT
async function getAIResponse(userText) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "אתה עוזר קולי בעברית, תענה תשובות קצרות וברורות." },
          { role: "user", content: userText },
        ],
      }),
    });

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "סליחה, לא שמעתי אותך טוב.";
  } catch (err) {
    console.error("❌ Error in GPT:", err.message);
    return "הייתה שגיאה בתגובה.";
  }
}

app.use(express.static("public"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
