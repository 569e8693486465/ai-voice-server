import express from "express";
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

// 📂 תיקייה לאודיו
const audioDir = path.join(__dirname, "public/audio");
fs.mkdirSync(audioDir, { recursive: true });
app.use("/audio", express.static(audioDir));

/**
 * 🗣️ פונקציה שמייצרת TTS עם ElevenLabs ושומרת כ‑mp3
 */
async function generateElevenAudioFile(text, filename = `tts_${Date.now()}.mp3`) {
  const voiceId = "UgBBYS2sOqTuMpoF3BR0"; // קול שלך ב‑ElevenLabs
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
  const buffer = Buffer.from(arrayBuffer);
  const filePath = path.join(audioDir, filename);
  fs.writeFileSync(filePath, buffer);
  return `${BASE_URL}/audio/${filename}`;
}

/**
 * 📞 TwiML endpoint – התחלת שיחה
 */
app.post("/api/phone/twiml", (req, res) => {
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="he-IL">שלום! דברו עכשיו ואני אחזור אליכם.</Say>
  <Record 
    action="/api/record"
    method="POST"
    maxLength="20"
    playBeep="true"
    trim="trim-silence" />
</Response>`;
  res.type("text/xml").send(xmlResponse);
});

/**
 * 🎙️ Record endpoint – המשתמש סיים לדבר
 */
app.post("/api/record", async (req, res) => {
  try {
    const recordingUrl = req.body.RecordingUrl; // Twilio מחזיר URL ל‑wav
    console.log("📥 Got recording URL:", recordingUrl);

    // הורדה של ההקלטה
    const audioResp = await fetch(`${recordingUrl}.wav`);
    const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
    fs.mkdirSync("tmp", { recursive: true });
    const tmpPath = path.join("tmp", `input_${Date.now()}.wav`);
    fs.writeFileSync(tmpPath, audioBuffer);

    // 1️⃣ Whisper STT
    const formData = new FormData();
    formData.append("file", await fileFromPath(tmpPath));
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
      // אם לא מזהה דיבור
      const emptyXml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="he-IL">לא שמעתי כלום. נסה שוב.</Say><Redirect>/api/phone/twiml</Redirect></Response>`;
      return res.type("text/xml").send(emptyXml);
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
          { role: "system", content: "אתה עוזר קולי בעברית קצר וברור." },
          { role: "user", content: userText },
        ],
      }),
    });

    const gptData = await gptResp.json();
    const replyText = gptData.choices?.[0]?.message?.content?.trim() || "לא הצלחתי להבין.";
    console.log("🤖 GPT replied:", replyText);

    // 3️⃣ ElevenLabs TTS
    const replyUrl = await generateElevenAudioFile(replyText);

    // 4️⃣ TwiML Play + Redirect ל‑TwiML הראשי
    const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${replyUrl}</Play>
  <Redirect>/api/phone/twiml</Redirect>
</Response>`;
    res.type("text/xml").send(xmlResponse);

  } catch (err) {
    console.error("❌ Error in /record:", err.message);
    const xmlError = `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="he-IL">אירעה שגיאה. נסה שוב מאוחר יותר.</Say></Response>`;
    res.type("text/xml").send(xmlError);
  }
});

/**
 * 🚀 הפעלת השרת
 */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
