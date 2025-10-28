import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";

dotenv.config();

const PORT = process.env.PORT || 8080;
const DOMAIN =
  (process.env.RENDER_EXTERNAL_URL || "ai-voice-server.onrender.com").replace(/^https?:\/\//, "");
const WS_URL = `wss://${DOMAIN}/relay`;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "UgBBYS2sOqTuMpoF3BR0";

if (!ELEVEN_API_KEY) console.error("❌ Missing ELEVEN_API_KEY!");
if (!OPENAI_API_KEY) console.error("❌ Missing OPENAI_API_KEY!");

// === Express setup ===
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// === TwiML endpoint ===
app.post("/api/phone/twiml", (req, res) => {
  console.log("📞 Twilio requested TwiML");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="wss://${DOMAIN}/relay"
      ttsProvider="elevenlabs"
      voice="${ELEVEN_VOICE_ID}-eleven_v3-0.8_0.8_0.6"
    />
  </Connect>
</Response>`;

  res.type("text/xml").send(xml);
});

// === WebSocket server (ConversationRelay) ===
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Twilio connected via ConversationRelay");

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    // 🔊 Media packet (raw audio)
    if (msg.event === "media") {
      const audioBase64 = msg.media.payload;
      const audioBuffer = Buffer.from(audioBase64, "base64");

      try {
        // --- 1️⃣ Speech-to-Text via ElevenLabs ---
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

        // --- 2️⃣ Generate GPT Response ---
        const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a helpful, friendly AI voice assistant." },
              { role: "user", content: text },
            ],
          }),
        });

        const gptData = await gptRes.json();
        const reply = gptData?.choices?.[0]?.message?.content || "Sorry, I didn’t catch that.";

        console.log(`🤖 GPT replied: ${reply}`);

        // --- 3️⃣ Send text back to Twilio for TTS playback ---
        ws.send(JSON.stringify({ type: "text", text: reply, last: true }));
      } catch (err) {
        console.error("❌ STT/GPT error:", err);
      }
    }

    if (msg.event === "start") {
      console.log("🚀 Call started:", msg.start.callSid);
    }

    if (msg.event === "stop") {
      console.log("🛑 Call ended");
    }
  });
});

// === HTTP + WS upgrade ===
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 ConversationRelay URL: ${WS_URL}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/relay") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
