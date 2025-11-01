import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "50mb" })); // כדי לאפשר טקסטים ארוכים

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // שים את המפתח שלך ב-env

// Route ל-Vapi
app.post("/tts", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim() === "") {
      return res.status(400).json({ error: "Missing text" });
    }

    // שליחה ל-Gemini TTS
    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=" + GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text }] }
          ],
          generationConfig: {
            responseMimeType: "audio/wav" // מבקשים WAV
          }
        })
      }
    );

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.error("Gemini TTS error:", errText);
      return res.status(500).json({ error: "Gemini TTS failed" });
    }

    // קבלת אודיו כ-buffer
    const audioBuffer = Buffer.from(await geminiResponse.arrayBuffer());

    // שולחים ל-Vapi
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(audioBuffer);

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Optional: בדיקה מהדפדפן
app.get("/", (req, res) => {
  res.send("Gemini TTS server is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
