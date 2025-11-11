import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Route to create a realtime session
app.get("/session", async (req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        voice: "verse",
      }),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error("Session creation failed:", e);
    res.status(500).json({ error: e.message });
  }
});

// WebSocket proxy: Client ↔ OpenAI Realtime
wss.on("connection", async (clientWs) => {
  console.log("🟢 Client connected");

  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // Pipe messages from OpenAI → Client
  openaiWs.on("message", (msg) => {
    const parsed = JSON.parse(msg);
    // Forward audio deltas immediately
    if (parsed.type === "response.output_audio.delta") {
      clientWs.send(JSON.stringify({ type: "audio-chunk", data: parsed.delta }));
    } else if (parsed.type === "response.completed") {
      clientWs.send(JSON.stringify({ type: "done" }));
    }
  });

  // Pipe messages from Client → OpenAI
  clientWs.on("message", (msg) => {
    openaiWs.send(msg.toString());
  });

  clientWs.on("close", () => openaiWs.close());
});

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
