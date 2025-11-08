import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import FormData from "form-data";

dotenv.config();

const app = express();
app.use(express.json());
app.use(bodyParser.raw({ type: ["audio/*"], limit: "60mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const SHARED_SECRET = process.env.SHARED_SECRET;

// יאוחסן כאן ה-session הפעיל
let currentHeygenSession = null;

// 🧩 פונקציה ליצירת סשן חדש ב־HeyGen
async function createHeygenSession() {
  console.log("🟡 Creating new HeyGen session...");
  const response = await fetch("https://api.heygen.com/v1/streaming.create_session", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HEYGEN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      avatar_name: "Pedro_Chair_Sitting_public",
      quality: "high",
      background: "transparent",
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`HeyGen session creation failed: ${JSON.stringify(data)}`);
  }

  currentHeygenSession = {
    session_id: data.data.session_id,
    stream_url: data.data.stream_url,
  };
  console.log("✅ New HeyGen session:", currentHeygenSession);
  return currentHeygenSession;
}

// ✅ מסלול לבדיקה
app.get("/", (req, res) => res.send("🤖 Avatar AI Server is running."));

// ✅ מסלול ליצירת סשן ידני (אופציונלי)
app.post("/create-heygen-session", async (req, res) => {
  try {
    const session = await createHeygenSession();
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ מסלול שמופעל ע"י Recall → ElevenLabs STT → GPT → HeyGen
app.post("/recall-audio", async (req, res) => {
  try {
    const secret = req.headers["x-shared-secret"];
    if (secret !== SHARED_SECRET) {
      return res.status(403).json({ error: "Unauthorized - invalid shared secret" });
    }

    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: "No audio data received" });
    }

    console.log("🎧 Received audio from Recall, size:", req.body.length);

    // 1️⃣ אם אין HeyGen session קיים – צור חדש
    if (!currentHeygenSession) {
      console.log("ℹ️ No active HeyGen session found, creating one...");
      await createHeygenSession();
    }

    // 2️⃣ שלח את האודיו ל־ElevenLabs STT
    const formData = new FormData();
    formData.append("file", req.body, { filename: "audio.wav" });

    const sttRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: formData,
    });

    const sttData = await sttRes.json();
    const transcription = sttData.text || "";
    console.log("🗣️ Transcribed text:", transcription);

    if (!transcription) {
      return res.status(400).json({ error: "Could not transcribe audio" });
    }

    // 3️⃣ צור תשובה עם GPT
    const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "אתה דמות וידאו וירטואלית ידידותית שמדברת בעברית בצורה חמה וטבעית." },
          { role: "user", content: transcription },
        ],
      }),
    });

    const gptData = await gptRes.json();
    const reply = gptData.choices?.[0]?.message?.content || "לא הבנתי אותך, תוכל לחזור?";
    console.log("💬 GPT reply:", reply);

    // 4️⃣ תן ל־HeyGen לדבר את התשובה
    const heygenSpeakRes = await fetch("https://api.heygen.com/v1/streaming.start_speaking", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HEYGEN_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: currentHeygenSession.session_id,
        text: reply,
      }),
    });

    const heygenData = await heygenSpeakRes.json();
    console.log("🗣️ HeyGen speaking:", heygenData);

    res.json({
      transcription,
      gpt_reply: reply,
      stream_url: currentHeygenSession.stream_url,
      heygen_response: heygenData,
    });
  } catch (err) {
    console.error("❌ Error in /recall-audio:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
