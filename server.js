import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import bodyParser from "body-parser";
dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;

// Endpoint used by your frontend to initiate a call via Twilio (optional)
app.post("/api/phone/initiate", async (req, res) => {
  try {
    const { phoneNumber, twilioAccountSid, twilioAuthToken, twilioPhoneNumber } = req.body;
    if (!phoneNumber || !twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    // We do not include the Twilio SDK here to keep this deploy simple and avoid shipping credentials in the ZIP.
    // Recommended: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER in Render env and use Twilio SDK.
    return res.json({ success: true, info: "Call initiation endpoint received request. Configure Twilio SDK in server.js if desired." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// TwiML endpoint Twilio calls to get ConversationRelay URL (must be HTTPS)
app.post("/api/phone/twiml", (req, res) => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL
    ? `https://${process.env.RENDER_EXTERNAL_URL}`
    : (process.env.BASE_URL || `https://${req.headers.host}`);
  const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/phone/ws";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${wsUrl}"
      welcomeGreeting="שלום! אני העוזרת הקולית. במה אפשר לעזור?"
      ttsProvider="Google"
      voice="he-IL-Standard-A"
      language="he-IL" />
  </Connect>
</Response>`;
  res.type("text/xml");
  res.send(twiml);
});

// WebSocket server — Twilio will upgrade to this for ConversationRelay
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Twilio connected via WebSocket");

  ws.on("message", async (message) => {
    const msg = message.toString();
    console.log("📩 From Twilio (text):", msg);

    // If GOOGLE_API_KEY is set and @google/generative-ai available, attempt to call Gemini.
    const googleKey = process.env.GOOGLE_API_KEY;
    if (googleKey) {
      try {
        // Lazy-load to avoid startup crash if package not installed locally in some environments.
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const client = new GoogleGenerativeAI({ apiKey: googleKey });
        // Start a chat and send the incoming message as user prompt.
        // API usage below assumes the package exposes a startChat/sendMessage-like interface.
        const model = client.getGenerativeModel
          ? client.getGenerativeModel({ model: "gemini-1.5" })
          : null;

        let replyText = "מצטער — שגיאה ביצירת תשובה.";
        if (model && typeof model.startChat === "function") {
          const chat = model.startChat();
          const result = await chat.sendMessage(msg);
          if (result && result.response && typeof result.response.text === "function") {
            replyText = result.response.text();
          } else if (result && result.response && result.response.text) {
            replyText = result.response.text;
          }
        } else {
          // fallback: try a simpler API surface
          if (typeof client.chat === "function") {
            const r = await client.chat({ model: "gemini-1.5", prompt: msg });
            replyText = r?.output?.[0]?.content || JSON.stringify(r);
          } else {
            replyText = "Gemini client does not expose expected methods in this runtime.";
          }
        }

        console.log("🤖 Gemini reply:", replyText);
        ws.send(replyText);
        return;
      } catch (e) {
        console.error("Error calling Gemini:", e);
        // fallthrough to simple reply
      }
    }

    // Default fallback reply (if no API key or error)
    const fallback = "שלום — שמח לדבר איתך! כרגע אין חיבור ל־Gemini, תוכל להגדיר את GOOGLE_API_KEY בסביבת Render.";
    ws.send(fallback);
  });

  ws.on("close", () => {
    console.log("❌ WebSocket closed");
  });
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
