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

  try {
    console.log("🔸 Creating OpenAI RealtimeClient...");
    const client = new RealtimeClient({ 
      apiKey: OPENAI_API_KEY,
    });

    // Log ALL events
    client.realtime.on("*", (event) => {
      console.log(`🔵 ${event.type}`);
      if (event.type.includes('response') || event.type.includes('error')) {
        console.log("📢 Important event:", event);
      }
    });

    client.realtime.on("response.audio.delta", (event) => {
      console.log("🔊 AI Audio Delta - Length:", event.delta?.length || 0);
      ws.send(JSON.stringify(event));
    });

    client.realtime.on("response.audio_transcript.delta", (event) => {
      console.log("💬 AI Transcript Delta:", event.delta);
      ws.send(JSON.stringify(event));
    });

    client.realtime.on("response.done", (event) => {
      console.log("✅ Response completed");
      ws.send(JSON.stringify(event));
    });

    client.realtime.on("error", (error) => {
      console.error("🔴 OpenAI Error:", error);
      ws.send(JSON.stringify({ type: "error", error: error.message }));
    });

    // Connect to OpenAI
    console.log("🔸 Connecting to OpenAI...");
    await client.connect();
    console.log("✅ Connected to OpenAI Realtime");

    // Configure session - SIMPLER version
    console.log("🔸 Configuring session...");
    await client.realtime.send('session.update', {
      modalities: ['audio'], // רק אודיו - יותר פשוט
      instructions: 'You are a helpful meeting assistant. When you hear someone speak, respond to them conversationally. Keep responses brief and friendly.',
      voice: 'alloy',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16'
    });
    console.log("✅ Session configured");

    let lastCommitTime = 0;
    let audioChunks = 0;

    // Set up message handling - SIMPLE approach
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        
        if (msg.type === "meeting_audio") {
          audioChunks++;
          
          // Send audio to OpenAI
          client.realtime.send("input_audio_buffer.append", {
            audio: msg.audio
          });

          // Commit every 5 chunks or every 2 seconds
          const now = Date.now();
          if (audioChunks >= 5 || now - lastCommitTime > 2000) {
            console.log(`🔔 Committing audio (chunks: ${audioChunks})...`);
            client.realtime.send("input_audio_buffer.commit", {});
            audioChunks = 0;
            lastCommitTime = now;
          }
        }
        
      } catch (e) {
        console.error("Error processing message:", e);
      }
    });

    // Send ready signal
    ws.send(JSON.stringify({ type: "ready", status: "connected" }));

    console.log("🎯 Waiting for audio input...");

    ws.on("close", () => {
      console.log("🔴 Client WebSocket closed");
      client.disconnect();
    });

  } catch (error) {
    console.error("❌ Failed to setup OpenAI:", error);
    ws.send(JSON.stringify({ 
      type: "error", 
      error: "Setup failed: " + error.message 
    }));
  }
});
