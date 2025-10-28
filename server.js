import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";

dotenv.config();

// === Configuration ===
const PORT = process.env.PORT || 8080;
const DOMAIN =
  (process.env.RENDER_EXTERNAL_URL || "ai-voice-server-t4l5.onrender.com").replace(/^https?:\/\//, "");
const WS_URL = `wss://${DOMAIN}/media`;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "UgBBYS2sOqTuMpoF3BR0";

if (!ELEVEN_API_KEY) console.error("❌ Missing ELEVEN_API_KEY!");
if (!OPENAI_API_KEY) console.error("❌ Missing OPENAI_API_KEY!");

// === Express setup ===
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// TwiML endpoint for Twilio
app.post("/api/phone/twiml", (req, res) => {
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${DOMAIN}/media" track="inbound_audio" />
  </Start>
  <Say>Hi! I’m your AI assistant. You can start talking now.</Say>
</Response>`;
  res.type("text/xml").send(xmlResponse);
});

// === WebSocket server for Media Streams ===
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Media Stream connected");
  let callSid = null;

  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case "start":
        callSid = msg.start.callSid;
        console.log(`📞 Call started: ${callSid}`);
        break;

      case "media":
        const audioBase64 = msg.media.payload;
        const audioBuffer = Buffer.from(audioBase64, "base64");

        try {
          // --- Speech to Text ---
          const sttRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
            method: "POST",
            headers: {
              "xi-api-key": ELEVEN_API_KEY,
              "Content-Type": "audio/wav",
            },
            body: audioBuffer,
          });

          const sttData = await sttRes.json();
          const text = sttData.text?.trim();
          if (!text) return;
          console.log(`🎙️ User said: ${text}`);

          // --- GPT Response ---
          const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: "You are a concise, friendly voice AI assistant." },
                { role: "user", content: text },
              ],
            }),
          });

          const gptData = await gptRes.json();
          const reply = gptData?.choices?.[0]?.message?.content || "Sorry, I didn’t catch that.";
          console.log("🤖 GPT replied:", reply);

          // --- Text to Speech ---
          const ttsRes = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
            {
              method: "POST",
              headers: {
                "xi-api-key": ELEVEN_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                text: reply,
                model_id: "eleven_monolingual_v3",
              }),
            }
          );

          const audioBufferReply = await ttsRes.arrayBuffer();
          // כאן תוכל לשלוח את האודיו חזרה לטוויליו (playback)
          // או לשמור אותו בקובץ, תלוי איך אתה רוצה לנהל את הזרימה.
        } catch (err) {
          console.error("❌ Error in STT/GPT/TTS pipeline:", err);
        }

        break;

      case "stop":
        console.log("🛑 Stream stopped:", callSid);
        break;
    }
  });
});

// === HTTP + WS upgrade ===
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Twilio Media Stream URL: ${WS_URL}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else socket.destroy();
});
