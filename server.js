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
  let currentAudioBuffers = [];
  let currentTranscript = "";

  // Relay: OpenAI -> Client (with buffering)
  openaiWs.on("message", (data) => {
    try {
      const event = JSON.parse(data);
      
      if (event.type === "response.output_audio.delta" && event.delta) {
        // Buffer audio chunks
        currentAudioBuffers.push(event.delta);
        console.log(`🔵 Buffering audio chunk (${currentAudioBuffers.length} total)`);
      }
      else if (event.type === "response.output_audio_transcript.delta" && event.delta) {
        // Buffer transcript
        currentTranscript += event.delta;
      }
      else if (event.type === "response.done") {
        // Send complete response to client
        console.log(`✅ Response complete - Sending ${currentAudioBuffers.length} audio buffers`);
        ws.send(JSON.stringify({
          type: "response.complete",
          audioBuffers: currentAudioBuffers,
          transcript: currentTranscript
        }));
        
        // Reset buffers
        currentAudioBuffers = [];
        currentTranscript = "";
      }
      else {
        // Forward other events immediately
        console.log(`🔵 OpenAI -> Client: ${event.type}`);
        ws.send(JSON.stringify(event));
      }
      
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

  // Relay: Client -> OpenAI
  const messageHandler = (data) => {
    try {
      const event = JSON.parse(data);
      
      if (event.type === "session.update") {
        console.log("🟡 Ignoring session.update from client");
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

    // Process queued messages
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
