import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// כתובת TTS שה-Vapi יקרא אליה
app.post("/tts", async (req, res) => {
  try {
    const { text } = req.body;

    // בקשה ל-Gemini כדי ליצור אודיו מהטקסט
    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=YOUR_GEMINI_API_KEY",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `Convert this text to spoken audio: ${text}` }],
            },
          ],
          generationConfig: {
            responseMimeType: "audio/wav",
          },
        }),
      }
    );

    // קורא את הנתונים כ-Buffer
    const audioBuffer = await geminiResponse.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString("base64");

    // שולח ל-Vapi אובייקט עם האודיו
    res.json({
      audio: audioBase64,
      format: "wav",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("Gemini TTS server is running!"));
app.listen(3000, () => console.log("Server running on port 3000"));
