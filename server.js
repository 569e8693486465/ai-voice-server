import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { RealtimeClient } from "@openai/realtime-api-beta";

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

  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

  // Handle OpenAI realtime events
  client.realtime.on("response.audio_transcript.done", (event) => {
    console.log("User said:", event.transcript);
  });

  client.realtime.on("response.audio.done", (event) => {
    console.log("AI response audio generated");
  });

  client.realtime.on("response.done", (event) => {
    console.log("AI response completed");
  });

  client.realtime.on("error", (error) => {
    console.error("OpenAI error:", error);
  });

  client.realtime.on("server.*", (event) => {
    // Forward relevant events to client
    if (event.type.includes('audio')) {
      ws.send(JSON.stringify(event));
    }
  });

  client.realtime.on("close", () => {
    console.log("OpenAI connection closed");
    ws.close();
  });

  try {
    await client.connect();
    console.log("✅ Connected to OpenAI Realtime");
    
    // Configure the session for conversation
    await client.realtime.send('session.update', {
      modalities: ['text', 'audio'],
      instructions: 'You are a helpful meeting assistant. Keep responses concise and professional.',
      voice: 'alloy',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: { model: 'whisper-1' }
    });

  } catch (error) {
    console.error("Failed to connect to OpenAI:", error);
    ws.close();
  }

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === "meeting_audio") {
        // Audio from meeting via Recall.ai
        client.realtime.send("input_audio_buffer.append", {
          audio: msg.audio
        });
        
        // Commit after each chunk to trigger processing
        client.realtime.send("input_audio_buffer.commit", {});
      }
      else if (msg.type === "meeting_transcript") {
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
