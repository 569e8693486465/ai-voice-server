import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { RealtimeClient } from "@openai/realtime-api-beta";

dotenv.config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const RECALL_API_KEY = process.env.RECALL_API_KEY; // Add this

if (!OPENAI_API_KEY || !RECALL_API_KEY) {
  console.error("Missing API keys in .env");
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

  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

  // Handle ALL OpenAI events - forward everything to client
  client.realtime.on("server.*", (event) => {
    console.log("OpenAI Event:", event.type);
    ws.send(JSON.stringify(event));
  });

  client.realtime.on("error", (error) => {
    console.error("OpenAI error:", error);
    ws.send(JSON.stringify({ type: "error", error: error.message }));
  });

  client.realtime.on("close", () => {
    console.log("OpenAI connection closed");
  });

  try {
    await client.connect();
    console.log("✅ Connected to OpenAI Realtime");
    
    // Better session configuration
    await client.realtime.send('session.update', {
      modalities: ['text', 'audio'],
      instructions: 'You are a helpful meeting assistant. Respond briefly and professionally. Keep responses under 10 seconds.',
      voice: 'alloy',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: { 
        model: 'whisper-1'
      },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500
      }
    });

    console.log("✅ Session configured");

  } catch (error) {
    console.error("Failed to connect to OpenAI:", error);
    ws.send(JSON.stringify({ type: "error", error: "OpenAI connection failed" }));
  }

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);
      console.log("Received message type:", msg.type);
      
      if (msg.type === "meeting_audio") {
        // Send audio to OpenAI
        client.realtime.send("input_audio_buffer.append", {
          audio: msg.audio
        });
        
        // Don't commit immediately - let OpenAI handle VAD
        // client.realtime.send("input_audio_buffer.commit", {});
        
      } else if (msg.type === "meeting_transcript") {
        console.log("Sending transcript to OpenAI:", msg.text);
        // Send transcript as text input
        client.realtime.send("conversation.item.create", {
          type: "message",
          role: "user", 
          content: [{ type: "input_text", text: msg.text }]
        });
      }
      
    } catch (e) {
      console.error("Error processing message:", e);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    client.disconnect();
  });
});
