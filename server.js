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

  try {
    console.log("🔸 Connecting to OpenAI Realtime API...");
    
    // Connect directly to OpenAI GA API
    const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
      headers: {
        Authorization: "Bearer " + OPENAI_API_KEY,
      },
    });

    openaiWs.on("open", function open() {
      console.log("✅ Connected to OpenAI Realtime API");
      
      // Simple session configuration - let OpenAI handle everything
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions: "You are a helpful meeting assistant. Respond briefly in English.",
          voice: "alloy",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          temperature: 0.7
          // NO turn_detection - let OpenAI handle it automatically
        }
      }));
      console.log("✅ Session configured");
    });

    openaiWs.on("message", function incoming(message) {
      try {
        const event = JSON.parse(message.toString());
        
        // Forward ALL important events to client
        if (event.type.includes('response') || event.type.includes('error')) {
          ws.send(JSON.stringify(event));
        }

        // Log for debugging
        if (event.type === "response.output_audio.delta") {
          console.log("🔊 AI Audio Response");
        } else if (event.type === "response.output_audio_transcript.delta") {
          console.log("💬 AI:", event.delta);
        } else if (event.type === "session.updated") {
          console.log("✅ Session ready");
          ws.send(JSON.stringify({ type: "ready" }));
        }
        
      } catch (error) {
        console.error("Error parsing OpenAI message:", error);
      }
    });

    openaiWs.on("error", function error(err) {
      console.error("🔴 OpenAI WebSocket error:", err);
    });

    openaiWs.on("close", function close() {
      console.log("🔴 OpenAI WebSocket closed");
    });

    // Handle messages from client - SIMPLE: just forward audio
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        
        if (msg.type === "meeting_audio" && openaiWs.readyState === WebSocket.OPEN) {
          // Send audio directly to OpenAI - NO buffering, NO committing
          openaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.audio
          }));
          
          // Let OpenAI handle when to process the audio
          // NO manual commit - OpenAI does this automatically
        }
        
      } catch (e) {
        console.error("Error processing client message:", e);
      }
    });

    // Clean up
    ws.on("close", () => {
      console.log("🔴 Client WebSocket closed");
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

  } catch (error) {
    console.error("❌ Failed to setup OpenAI:", error);
  }
});
