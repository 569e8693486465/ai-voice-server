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

// ✅ Endpoint שמחזיר את ה־TwiML לטוויליו
app.post("/api/phone/twiml", (req, res) => {
  const baseUrl =
    process.env.RENDER_EXTERNAL_URL ||
    process.env.BASE_URL ||
    req.headers.host ||
    "localhost";

  // ✅ כאן נמנעים מ-wss://https:// כפול
  const wsUrl = `wss://${baseUrl}/api/phone/ws`;

  console.log("[TwiML] Using WebSocket URL:", wsUrl);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${wsUrl}"
      welcomeGreeting="שלום! אני העוזרת הקולית מבוססת Gemini Live. איך אפשר לעזור?"
      ttsProvider="Google"
      voice="he-IL-Standard-A"
      language="he-IL" />
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

// ✅ שרת WebSocket — כאן Twilio תדבר איתנו
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Twilio connected via WebSocket");

  ws.on("message", async (message) => {
    const text = message.toString();
    console.log("🗣️ User said:", text);

    const apiKey = process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      ws.send("אין חיבור ל־Gemini (לא הוגדר GOOGLE_API_KEY).");
      return;
    }

    try {
      // ✅ Gemini LIVE API endpoint
      const geminiStream = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse",
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

      let fullText = "";
      const reader = geminiStream.body.getReader();
      const decoder = new TextDecoder();

      // ✅ קריאה "חי" מהמודל
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
      }

      // ננסה לחלץ את התשובה מתוך הזרם
      const match = fullText.match(/"text":\s*"([^"]+)"/);
      const reply = match ? match[1] : "לא הבנתי אותך, נסה שוב.";

      console.log("🤖 Gemini Live Reply:", reply);
      ws.send(reply);
    } catch (err) {
      console.error("❌ Error talking to Gemini Live:", err);
      ws.send("שגיאה בתקשורת עם Gemini Live API.");
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
