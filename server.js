// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("✅ Recall + HeyGen bridge is running!");
});

app.post(
  "/recall-audio",
  bodyParser.raw({ type: ["audio/*"], limit: "60mb" }),
  async (req, res) => {
    try {
      console.log("🎧 Received audio from Recall");

      if (!req.body || !req.body.length) {
        return res.status(400).send("No audio data received");
      }

      // 1️⃣ Speech-to-Text (ElevenLabs)
      const sttResponse = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "audio/mpeg",
        },
        body: req.body,
      });

      const sttData = await sttResponse.json();
      const transcript = sttData.text || sttData.transcript || "";
      console.log("🗣️ Transcribed text:", transcript);

      if (!transcript) {
        return res.status(400).send("No transcription result from ElevenLabs");
      }

      // 2️⃣ GPT-4o-mini response
      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You are a friendly virtual avatar speaking naturally in conversation.",
            },
            { role: "user", content: transcript },
          ],
        }),
      });

      const aiData = await openaiResponse.json();
      const aiText = aiData.choices?.[0]?.message?.content?.trim() || "";
      console.log("🤖 GPT Response:", aiText);

      if (!aiText) {
        return res.status(400).send("No GPT response");
      }

      // 3️⃣ HeyGen Interactive Speak
      const heygenSession = process.env.HEYGEN_SESSION_ID;
      const heygenApiKey = process.env.HEYGEN_API_KEY;

      if (!heygenSession) {
        console.error("❌ Missing HEYGEN_SESSION_ID in .env");
        return res.status(400).send("Missing HeyGen session");
      }

      const heygenResponse = await fetch("https://api.heygen.com/v1/streaming.speak", {
        method: "POST",
        headers: {
          "x-api-key": heygenApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: heygenSession,
          text: aiText,
        }),
      });

      const heygenData = await heygenResponse.json();
      console.log("🦾 Sent to HeyGen:", heygenData);

      res.json({ transcript, aiText, heygen: heygenData });
    } catch (err) {
      console.error("❌ Error in /recall-audio:", err);
      res.status(500).send("Internal server error");
    }
  }
);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
