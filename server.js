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

    // Log ALL events to see what's happening
    client.realtime.on("*", (event) => {
      console.log(`🔵 ${event.type}`);
      
      // Forward ALL events to the client
      ws.send(JSON.stringify(event));
    });

    client.realtime.on("response.audio.delta", (event) => {
      console.log("🔊 AI Audio Response Received!", event.delta ? "Has audio" : "No audio");
    });

    client.realtime.on("response.audio_transcript.delta", (event) => {
      console.log("💬 AI Transcript:", event.delta);
    });

    client.realtime.on("error", (error) => {
      console.error("🔴 OpenAI Error:", error);
    });

    // Connect to OpenAI
    console.log("🔸 Connecting to OpenAI...");
    await client.connect();
    console.log("✅ Connected to OpenAI Realtime");

    // Configure session with BOTH text and audio
    console.log("🔸 Configuring session...");
    await client.realtime.send('session.update', {
      modalities: ['text', 'audio'], // חשוב: גם טקסט גם אודיו
      instructions: 'You are a helpful meeting assistant. Respond briefly in conversation. When someone speaks to you, answer them directly and conversationally. Keep responses under 10 words.',
      voice: 'alloy',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 1000
      }
    });
    console.log("✅ Session configured");

    let audioBuffer = [];
    let commitTimer = null;

    // Set up message handling
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        
        if (msg.type === "meeting_audio") {
          // Send audio immediately without buffering
          client.realtime.send("input_audio_buffer.append", {
            audio: msg.audio
          });
          
          // Clear any existing timer
          if (commitTimer) clearTimeout(commitTimer);
          
          // Commit after a short delay to allow VAD to work
          commitTimer = setTimeout(() => {
            console.log("🔔 Committing audio buffer (VAD trigger)...");
            client.realtime.send("input_audio_buffer.commit", {});
          }, 500);
        }
        
      } catch (e) {
        console.error("Error processing message:", e);
      }
    });

    // Send ready signal to client
    ws.send(JSON.stringify({ type: "ready", status: "connected" }));

    // Test: Send a welcome message after 3 seconds
    setTimeout(async () => {
      console.log("🎯 Sending test welcome message...");
      await client.realtime.send("conversation.item.create", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say hello and introduce yourself as the meeting assistant" }]
      });
    }, 3000);

    ws.on("close", () => {
      console.log("🔴 Client WebSocket closed");
      if (commitTimer) clearTimeout(commitTimer);
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
