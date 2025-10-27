import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// 🟢 Port set to 3000 for compatibility with Next.js / Render
const PORT = process.env.PORT || 3000;

const DOMAIN =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  "ai-voice-server-t4l5.onrender.com";

const WS_URL = `wss://${DOMAIN}/api/phone/ws`;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_VOICE_ID = "cTufqKY4lz94DWjU7clk";

if (!ELEVEN_API_KEY) console.error("❌ Missing ELEVEN_API_KEY!");
if (!OPENAI_API_KEY) console.error("❌ Missing OPENAI_API_KEY!");

// ✅ Twilio connects here to get TwiML
app.post("/api/phone/twiml", (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Connect>
      <ConversationRelay 
        url="${WS_URL}" 
        welcomeGreeting="שלום! אני העוזרת הקולית שלך. איך אפשר לעזור היום?"
        ttsProvider="ElevenLabs"
        voice="${ELEVEN_VOICE_ID}"
      />
    </Connect>
  </Response>`;
  res.type("text/xml");
  res.send(xml);
});

const sessions = new Map();

// ✅ WebSocket server
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Twilio connected via WebSocket");
  let callSid = null;

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "setup") {
        callSid = msg.callSid;
        console.log(`🟢 Setup for call ${callSid}`);
        sessions.set(callSid, []);
      }

      // When user speaks
      else if (msg.type === "media" && msg.media?.payload) {
        const audioBase64 = msg.media.payload;
        const audioBuffer = Buffer.from(audioBase64, "base64");

        // 1️⃣ Convert speech → text via ElevenLabs STT
        const sttResponse = await fetch(
          "https://api.elevenlabs.io/v1/speech-to-text",
          {
            method: "POST",
            headers: {
              "xi-api-key": ELEVEN_API_KEY,
              "Content-Type": "audio/mpeg",
            },
            body: audioBuffer,
          }
        );

        const sttData = await sttResponse.json();
        const userText = sttData?.text || "";
        console.log("🗣️ User said:", userText);

        if (!userText) return;

        // 2️⃣ Get reply from GPT-4o mini
        const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: userText }],
          }),
        });

        const gptData = await gptResponse.json();
        const reply = gptData?.choices?.[0]?.message?.content || "לא הבנתי אותך.";

        console.log("🤖 GPT replied:", reply);

        // 3️⃣ Convert reply → speech via ElevenLabs TTS
        const ttsResponse = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
          {
            method: "POST",
            headers: {
              "xi-api-key": ELEVEN_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: reply,
              model_id: "eleven_tts_v3",
              voice_settings: { stability: 0.6, similarity_boost: 0.8 },
            }),
          }
        );

        const audioReply = await ttsResponse.arrayBuffer();
        const audioReplyBase64 = Buffer.from(audioReply).toString("base64");

        // 4️⃣ Send back as audio
        ws.send(
          JSON.stringify({
            type: "media",
            media: { payload: audioReplyBase64 },
          })
        );
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

const server = app.listen(PORT, () =>
  console.log(`🚀 Voice server running on port ${PORT}`)
);

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/api/phone/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else socket.destroy();
});
