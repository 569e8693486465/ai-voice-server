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

    // Add detailed event logging
    client.realtime.on("session.created", (event) => {
      console.log("✅ session.created");
    });

    client.realtime.on("session.updated", (event) => {
      console.log("✅ session.updated");
    });

    client.realtime.on("input_audio_buffer.committed", (event) => {
      console.log("🎤 input_audio_buffer.committed");
    });

    client.realtime.on("response.audio.delta", (event) => {
      console.log("🔊 response.audio.delta - AI speaking!");
    });

    client.realtime.on("response.audio_transcript.delta", (event) => {
      console.log("💬 AI transcript:", event.delta);
    });

    client.realtime.on("error", (error) => {
      console.error("🔴 OpenAI Error:", error);
      console.error("Error details:", JSON.stringify(error, null, 2));
    });

    client.realtime.on("close", (event) => {
      console.log("🟠 OpenAI connection closed:", event);
    });

    // Connect to OpenAI
    console.log("🔸 Connecting to OpenAI...");
    await client.connect();
    console.log("✅ Connected to OpenAI Realtime");

    // Use minimal session configuration
    console.log("🔸 Configuring session...");
    await client.realtime.send('session.update', {
      modalities: ['audio'],
      voice: 'alloy',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16'
    });
    console.log("✅ Session configured");

    // Set up message handling AFTER successful connection
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        
        if (msg.type === "meeting_audio") {
          console.log("🎤 Received audio chunk:", msg.audio.length, "bytes");
          
          // Send audio to OpenAI
          client.realtime.send("input_audio_buffer.append", {
            audio: msg.audio
          });
          
          // Commit to trigger processing
          client.realtime.send("input_audio_buffer.commit", {});
        }
        
      } catch (e) {
        console.error("Error processing message:", e);
      }
    });

    ws.on("close", () => {
      console.log("🔴 Client WebSocket closed");
      client.disconnect();
    });

    // Send ready signal to client
    ws.send(JSON.stringify({ type: "ready", status: "connected" }));

  } catch (error) {
    console.error("❌ Failed to setup OpenAI:", error);
    console.error("Stack:", error.stack);
    ws.send(JSON.stringify({ 
      type: "error", 
      error: "Setup failed: " + error.message 
    }));
  }
});
