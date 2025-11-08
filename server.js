import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import path from "path";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// כדי לטפל בקבצי אודיו בינאריים מה-Recall bot
app.use(bodyParser.raw({ type: "audio/*", limit: "50mb" }));
app.use(bodyParser.json());

// ---------------------------------------------------------
// הגדרת נתיבי בדיקה
// ---------------------------------------------------------
app.get("/", (req, res) => {
  res.send("✅ HeyGen + Recall + ElevenLabs server is running!");
});

// ---------------------------------------------------------
// יצירת HeyGen streaming session (נקרא מהלקוח אם רוצים Avatar חי)
// ---------------------------------------------------------
app.post("/create-heygen-session", async (req, res) => {
  try {
    const avatarId = "Pedro_Chair_Sitting_public"; // אתה כבר ציינת את זה
    const response = await axios.post(
      "https://api.heygen.com/v1/streaming.create_session",
      { avatar_id: avatarId, voice_id: "en_us_001" },
      {
        headers: {
          "X-API-KEY": process.env.HEYGEN_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const streamUrl = response.data.data.stream_url;
    const sessionId = response.data.data.session_id;

    console.log("✅ HeyGen session created:", { sessionId, streamUrl });
    res.json({ sessionId, streamUrl });
  } catch (err) {
    console.error("❌ Error creating HeyGen session:", err.response?.data || err);
    res.status(500).json({ error: "Failed to create HeyGen session" });
  }
});

// ---------------------------------------------------------
// Webhook של Recall שמקבל אודיו תוך כדי פגישה
// ---------------------------------------------------------
app.post("/recall-audio", async (req, res) => {
  try {
    const sharedSecret = req.headers["x-shared-secret"];
    if (sharedSecret !== process.env.SHARED_SECRET) {
      console.log("⚠️ Invalid shared secret");
      return res.status(403).send("Forbidden");
    }

    // שמירת הקובץ זמנית
    const filename = `${uuidv4()}.wav`;
    const filePath = path.join(__dirname, "temp", filename);
    fs.mkdirSync(path.join(__dirname, "temp"), { recursive: true });
    fs.writeFileSync(filePath, req.body);

    console.log("🎧 Received audio chunk:", filename);

    // -----------------------------------------------------
    // 1️⃣ שליחה ל־ElevenLabs STT
    // -----------------------------------------------------
    const audioData = fs.readFileSync(filePath);
    const sttResp = await axios.post(
      "https://api.elevenlabs.io/v1/speech-to-text",
      audioData,
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "audio/wav",
        },
      }
    );

    const transcript = sttResp.data.text?.trim();
    console.log("🗣️ Transcript:", transcript);

    if (!transcript) {
      fs.unlinkSync(filePath);
      return res.status(200).send("No speech detected");
    }

    // -----------------------------------------------------
    // 2️⃣ שליחה ל־GPT לקבלת תגובה חכמה
    // -----------------------------------------------------
    const gptResp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "אתה אוואטר בשם Pedro שמנהל שיחה חביבה ומנומסת.",
          },
          { role: "user", content: transcript },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const reply = gptResp.data.choices[0].message.content.trim();
    console.log("🤖 GPT reply:", reply);

    // -----------------------------------------------------
    // 3️⃣ שליחה ל־HeyGen להקראת הטקסט ע״י האוואטר
    // -----------------------------------------------------
    await axios.post(
      "https://api.heygen.com/v1/streaming.generate_audio",
      {
        session_id: process.env.HEYGEN_SESSION_ID,
        text: reply,
      },
      {
        headers: {
          "X-API-KEY": process.env.HEYGEN_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("🎬 Sent reply to HeyGen Avatar");
    fs.unlinkSync(filePath);
    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Error handling audio:", err.response?.data || err);
    res.status(500).send("Error processing audio");
  }
});

// ---------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
