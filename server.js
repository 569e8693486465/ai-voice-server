import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";

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
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

if (!GOOGLE_API_KEY) {
  console.error("❌ Missing GOOGLE_API_KEY in environment variables!");
}

const WELCOME_GREETING =
  "Hi! I am a voice assistant powered by Twilio and Google Gemini. Ask me anything!";
const SYSTEM_PROMPT = `
You are a helpful and friendly voice assistant. This conversation is happening over a phone call.
Follow these rules:
1. Be concise and clear.
2. Speak naturally.
3. Avoid special characters or emojis.
4. Keep your tone friendly and conversational.
`;

// ✅ Twilio asks this endpoint for TwiML to know where to connect
app.post("/api/phone/twiml", (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay 
      url="${WS_URL}" 
      welcomeGreeting="${WELCOME_GREETING}" 
      ttsProvider="Google"
      voice="en-US-Standard-C" 
      language="en-US" />
  </Connect>
</Response>`;
  res.type("text/xml");
  res.send(xml);
});

// ✅ Store conversation history (in memory)
const sessions = new Map();

// ✅ WebSocket server for real-time voice communication
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Twilio connected via WebSocket");

  let callSid = null;

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "setup") {
        callSid = msg.callSid;
        console.log(`🟢 Setup for call: ${callSid}`);
        sessions.set(callSid, []);
      }

      else if (msg.type === "prompt") {
        const userPrompt = msg.voicePrompt;
        console.log(`🗣️ User said: ${userPrompt}`);

        const history = sessions.get(callSid) || [];
        history.push({ role: "user", parts: [{ text: userPrompt }] });

        // ✅ Correct Gemini API call using ?key=
        const geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GOOGLE_API_KEY}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents: [
                { role: "system", parts: [{ text: SYSTEM_PROMPT }] },
                ...history,
              ],
            }),
          }
        );

        const data = await geminiResponse.json();
        console.log("🧠 Gemini full response:", JSON.stringify(data, null, 2));

        const reply =
          data?.candidates?.[0]?.content?.parts?.[0]?.text ||
          "Sorry, I didn’t catch that.";

        console.log("🤖 Gemini replied:", reply);

        history.push({ role: "model", parts: [{ text: reply }] });
        sessions.set(callSid, history);

        ws.send(
          JSON.stringify({
            type: "text",
            token: reply,
            last: true,
          })
        );
      }

      else if (msg.type === "interrupt") {
        console.log(`🚫 Call interrupted for ${callSid}`);
      }
    } catch (err) {
      console.error("❌ Error handling message:", err);
    }
  });

  ws.on("close", () => {
    console.log(`❌ Twilio disconnected: ${callSid}`);
    if (callSid) sessions.delete(callSid);
  });
});

// ✅ Handle upgrade to WebSocket
const server = app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/api/phone/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
