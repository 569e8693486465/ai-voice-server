import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(bodyParser.raw({ type: "audio/*", limit: "60mb" }));
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const SHARED_SECRET = process.env.SHARED_SECRET;

// 🧩 פונקציה ליצירת session חדש בכל פעם
async function createHeygenSession() {
  console.log("🟡 Creating new HeyGen session...");
  const res = await fetch("https://api.heygen.com/v1/streaming.create_session", {
    method: "POST",
    headers: {
      "X-API-KEY": HEYGEN_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      avatar_name: "Pedro_Chair_Sitting_public",
      quality: "high",
      background: "transparent",
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("❌ HeyGen session creation failed:", data);
    throw new Error(`HeyGen session creation failed`);
  }

  console.log("✅ New HeyGen session created:", data.data);
  return {
    session_id: data.data.session_id,
    stream_url: data.data.stream_url,
  };
}

// ✅ בדיקה שהשרת עובד
app.get("/", (req, res) => res.send("🤖 Avatar AI Server is running."));

// ✅ נקודת קבלת האודיו מה־Recall Bot
app.post("/recall-audio", async (req, res) => {
  try {
    const secret = req.headers["x-shared-secret"];
    if (secret !== SHARED_SECRET) {
      console.log("🚫 Invalid shared secret");
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: "No audio data received" });
    }

    console.log("🎧 Received audio chunk, size:", req.body.length);

    // שמירת הקובץ הזמני
    const filename = `${uuidv4()}.wav`;
    const filepath = path.join(__dirname, "temp", filename);
    fs.mkdirSync(path.join(__dirname, "temp"), { recursive: true });
    fs.writeFileSync(filepath, req.body);

    // 1️⃣ המרה ל־טקסט עם ElevenLabs
    const sttRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: fs.createReadStream(filepath),
    });

    const sttData = await sttRes.json();
    const transcription = sttData.text || "";
    console.log("🗣️ Transcribed text:", transcription);

    if (!transcription) {
      fs.unlinkSync(filepath);
      return res.status(200).send("No speech detected");
    }

    // 2️⃣ הפעלת GPT
    const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "אתה דמות וידאו וירטואלית בשם פדרו, מדבר בעברית טבעית וחמה.",
          },
          { role: "user", content: transcription },
        ],
      }),
    });

    const gptData = await gptRes.json();
    const reply = gptData.choices?.[0]?.message?.content || "לא הבנתי אותך.";
    console.log("💬 GPT reply:", reply);

    // 3️⃣ יצירת סשן חדש ב־HeyGen
    const { session_id, stream_url } = await createHeygenSession();

    // 4️⃣ שליחה ל־HeyGen לדבר
    const speakRes = await fetch("https://api.heygen.com/v1/streaming.start_speaking", {
      method: "POST",
      headers: {
        "X-API-KEY": HEYGEN_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id,
        text: reply,
      }),
    });

    const heygenData = await speakRes.json();
    console.log("🎬 HeyGen speaking:", heygenData);

    fs.unlinkSync(filepath);

    res.json({
      transcription,
      reply,
      heygen_stream: stream_url,
    });
  } catch (err) {
    console.error("❌ Error in /recall-audio:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ הפעלת השרת
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
