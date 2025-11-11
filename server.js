import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

const app = express();
app.use(express.static("public"));

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", async (ws) => {
  console.log("🟢 Client connected");

  // Connect to OpenAI GA API
  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
    headers: {
      Authorization: "Bearer " + OPENAI_API_KEY,
    },
  });

  // Simple relay - just forward messages
  openaiWs.on("message", (data) => {
    ws.send(data); // Forward raw data without parsing
  });

  openaiWs.on("error", (err) => {
    console.error("🔴 OpenAI error:", err);
  });

  openaiWs.on("close", () => {
    console.log("🔴 OpenAI connection closed");
    ws.close();
  });

  // Forward all client messages to OpenAI
  ws.on("message", (data) => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(data);
    }
  });

  ws.on("close", () => {
    console.log("🔴 Client disconnected");
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  // Configure session when OpenAI connects
  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI");
    
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime",
        instructions: "You are a helpful meeting assistant. Respond briefly in English.",
        voice: "alloy",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        temperature: 0.7,
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    }));
  });
});

console.log(`WebSocket server listening on port ${PORT}`);
