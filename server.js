import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import fs from "fs";
import FormData from "form-data";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;
const DOMAIN =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  "ai-voice-server-t4l5.onrender.com";

const WS_URL = `wss://${DOMAIN}/api/phone/ws`;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!ELEVEN_API_KEY || !OPENAI_API_KEY) {
  console.error("❌ Missing ELEVEN_API_KEY or OPENAI_API_KEY in .env file");
  process.exit(1);
}

// voice ID לשימוש ב־ElevenLabs TTS
const VOICE_ID = "cTufqKY4lz94DWjU7clk";

// ✅ Twilio יקבל את ה־TwiML כדי לדעת לאן לחבר את השיחה
app.post("/api/phone/twiml", (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay 
      url="${WS_URL}" 
      welcomeGreeting="שלום! אני העוזרת הקולית שלך. איך אפשר לעזור?"
      ttsProvider="none" />
  </Connect>
</Response>`;
  res.type("text/xml");
  res.send(xml);
});

// ✅ נשתמש ב־WebSocket לקבלת אודיו בזמן אמת מטוויליו
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Twilio connected via WebSocket");

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "setup") {
      console.log(`🟢 Call setup: ${msg.callSid}`);
    }

    // כשהיוזר מדבר
    else if (msg.type === "prompt") {
      const audioBase64 = msg.audio || msg.voicePrompt;
      console.log("🎤 Received audio from user");

      if (!audioBase64) {
        console.error("❌ No audio data received.");
        return;
      }

      // המרת הבייס64 לקובץ זמני
      const buffer = Buffer.from(audioBase64, "base64");
      fs.writeFileSync("input.wav", buffer);

      // 🎧 שליחה ל־ElevenLabs STT
      const formData = new FormData();
      formData.append("file", fs.createReadStream("input.wav"));

      const sttResponse = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": ELEVEN_API_KEY },
        body: formData,
      });

      const sttData = await sttResponse.json();
      const userText = sttData?.text || "";
      console.log("🗣️ Transcribed:", userText);

      // שליחה ל־GPT-4o-mini
      const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "את עוזרת קולית ידידותית שעונה בעברית בצורה טבעית וברורה." },
            { role: "user", content: userText },
          ],
        }),
      });

      const gptData = await gptResponse.json();
      const reply = gptData?.choices?.[0]?.message?.content || "לא הבנתי אותך, תוכל לחזור שוב?";
      console.log("🤖 GPT replied:", reply);

      // שליחה ל־ElevenLabs TTS (עברית)
      const ttsResponse = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVEN_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: reply,
            model_id: "eleven_multilingual_v3",
            voice_settings: { stability: 0.4, similarity_boost: 0.8 },
          }),
        }
      );

      const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
      const audioBase64Reply = audioBuffer.toString("base64");

      // שליחה בחזרה ל־Twilio (שישמיע את זה)
      ws.send(
        JSON.stringify({
          type: "audio",
          audio: audioBase64Reply,
          last: true,
        })
      );

      console.log("🔊 Sent audio reply back to Twilio");
    }
  });

  ws.on("close", () => console.log("❌ Twilio disconnected"));
});

// ✅ הפעלת השרת
const server = app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/api/phone/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});
