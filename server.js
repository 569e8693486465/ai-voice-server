import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";

dotenv.config();

// --- Configuration ---
const PORT = process.env.PORT || 8080;

// ⚙️ Your Render domain — example: ai-voice-server.onrender.com
let DOMAIN =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  "ai-voice-server.onrender.com";

DOMAIN = DOMAIN.replace(/^https?:\/\//, ""); // clean https://

// WebSocket URL for Twilio ConversationRelay
const WS_URL = `wss://${DOMAIN}/ws`;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_VOICE_ID = "UgBBYS2sOqTuMpoF3BR0"; // ← your ElevenLabs voice ID

if (!ELEVEN_API_KEY) console.error("❌ Missing ELEVEN_API_KEY!");
if (!OPENAI_API_KEY) console.error("❌ Missing OPENAI_API_KEY!");

// --- Express setup ---
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Twilio TwiML endpoint ---
app.post("/api/phone/twiml", (req, res) => {
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${WS_URL}"
      welcomeGreeting="Hi there! I'm your AI voice assistant. How can I help you today?"
      ttsProvider="ElevenLabs"
      voice="${ELEVEN_VOICE_ID}-turbo_v2_5-0.8_0.8_0.6" />
  </Connect>
</Response>`;
  res.type("text/xml").send(xmlResponse);
});

// --- Sessions store ---
const sessions = new Map();

// --- WebSocket server ---
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Twilio connected via WebSocket");
  let callSid = null;

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // 🟢 Setup event
      if (msg.type === "setup") {
        callSid = msg.callSid;
        console.log(`🟢 Setup for call ${callSid}`);
        sessions.set(callSid, []);
      }

      // 🎤 When Twilio sends a recognized voice prompt
      else if (msg.type === "prompt") {
        const userText = msg.voicePrompt?.trim();
        if (!userText) return;

        console.log(`🗣️ User said: ${userText}`);

        // 🤖 Generate a response via GPT-4o-mini
        const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "You are a concise, friendly voice AI." },
                       { role: "user", content: userText }],
          }),
        });

        const gptData = await gptResponse.json();
        const reply = gptData?.choices?.[0]?.message?.content || "Sorry, I didn't catch that.";

        console.log("🤖 GPT replied:", reply);

        // 🗣️ Send the reply text back to Twilio (it’ll be spoken with ElevenLabs TTS)
        ws.send(
          JSON.stringify({
            type: "text",
            token: reply,
            last: true,
          })
        );
      }

      else if (msg.type === "interrupt") {
        console.log(`⚠️ Interruption received for call ${callSid}`);
      }

      else if (msg.type === "close") {
        console.log(`❌ Call ended ${callSid}`);
        if (callSid) sessions.delete(callSid);
      }
    } catch (err) {
      console.error("❌ Error:", err);
    }
  });

  ws.on("close", () => {
    console.log(`🔚 WebSocket closed for ${callSid}`);
    if (callSid) sessions.delete(callSid);
  });
});

// --- HTTP server + WebSocket upgrade ---
const server = app.listen(PORT, () => {
  console.log(`🚀 Voice server running on port ${PORT}`);
  console.log(`🌐 WebSocket URL for Twilio: ${WS_URL}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else socket.destroy();
});
