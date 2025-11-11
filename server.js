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

  const messageQueue = [];

  // Relay: OpenAI -> Client
  openaiWs.on("message", (data) => {
    try {
      const event = JSON.parse(data);
      console.log(`🔵 OpenAI -> Client: ${event.type}`);
      ws.send(JSON.stringify(event));
    } catch (error) {
      console.error("Error parsing OpenAI message:", error);
    }
  });

  openaiWs.on("error", (err) => {
    console.error("🔴 OpenAI error:", err);
  });

  openaiWs.on("close", () => {
    console.log("🔴 OpenAI connection closed");
    ws.close();
  });

  // Relay: Client -> OpenAI (but handle session.update differently)
  const messageHandler = (data) => {
    try {
      const event = JSON.parse(data);
      
      // Don't forward session.update from client - we handle it on server
      if (event.type === "session.update") {
        console.log("🟡 Ignoring session.update from client (already handled by server)");
        return;
      }
      
      console.log(`🟡 Client -> OpenAI: ${event.type}`);
      openaiWs.send(JSON.stringify(event));
    } catch (error) {
      console.error("Error parsing client message:", error);
    }
  };

  ws.on("message", (data) => {
    if (openaiWs.readyState !== WebSocket.OPEN) {
      messageQueue.push(data);
    } else {
      messageHandler(data);
    }
  });

  ws.on("close", () => {
    console.log("🔴 Client disconnected");
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  // Wait for OpenAI connection and send session config
  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI");
    
    // Send session configuration from SERVER only
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime",
        instructions: "You are a helpful meeting assistant. Respond briefly in English. Keep responses under 10 words.",
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
    
    console.log("✅ Session configuration sent from server");

    // Process queued messages (except session.update)
    while (messageQueue.length) {
      const data = messageQueue.shift();
      try {
        const event = JSON.parse(data);
        if (event.type !== "session.update") {
          openaiWs.send(JSON.stringify(event));
        }
      } catch (error) {
        console.error("Error processing queued message:", error);
      }
    }
  });
});

console.log(`WebSocket server listening on port ${PORT}`);
