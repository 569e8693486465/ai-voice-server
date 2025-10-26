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

// ✅ Twilio endpoint — tells Twilio to connect via WebSocket
app.post("/api/phone/twiml", (req, res) => {
  const rawBase =
    process.env.RENDER_EXTERNAL_URL ||
    process.env.BASE_URL ||
    req.headers.host ||
    "localhost";

  // Remove "https://" or "http://"
  const cleanBase = rawBase.replace(/^https?:\/\//, "");

  const wsUrl = `wss://${cleanBase}/api/phone/ws`;
  console.log("[TwiML] Using WebSocket URL:", wsUrl);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${wsUrl}"
      welcomeGreeting="Hello! I’m your AI voice assistant powered by Gemini. How can I help you today?"
      ttsProvider="Google"
      voice="en-US-Standard-C"
      language="en-US" />
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

// ✅ WebSocket server — where Twilio and Gemini talk
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Twilio connected via WebSocket");

  ws.on("message", async (message) => {
    const text = message.toString();
    console.log("🗣️ User said:", text);

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      ws.send("❌ Missing GOOGLE_API_KEY.");
      return;
    }

    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text }] }],
          }),
        }
      );

      const data = await response.json();
      const reply =
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        "I'm not sure how to respond to that.";

      console.log("🤖 Gemini replied:", reply);
      ws.send(reply);
    } catch (err) {
      console.error("❌ Error talking to Gemini:", err);
      ws.send("Error connecting to Gemini API.");
    }
  });

  ws.on("close", () => console.log("❌ Twilio disconnected"));
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/api/phone/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
