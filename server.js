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

    // Add detailed event logging for ALL events
    client.realtime.on("*", (event) => {
      console.log(`🔵 ${event.type}`, event);
    });

    client.realtime.on("response.audio.delta", (event) => {
      console.log("🔊 AI Audio Response Received!");
      ws.send(JSON.stringify(event));
    });

    client.realtime.on("response.audio_transcript.delta", (event) => {
      console.log("💬 AI Transcript:", event.delta);
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

    // Configure session with conversation settings
    console.log("🔸 Configuring session...");
    await client.realtime.send('session.update', {
      modalities: ['text', 'audio'],
      instructions: 'You are a helpful meeting assistant. Respond briefly and conversationally. Keep responses under 10 words.',
      voice: 'alloy',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      turn_detection: null, // Let client control when to process
      temperature: 0.8
    });
    console.log("✅ Session configured");

    let audioBuffer = [];
    let isProcessing = false;

    // Set up message handling
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        
        if (msg.type === "meeting_audio") {
          // Add audio to buffer
          audioBuffer.push(msg.audio);
          
          // If we have enough audio chunks, process them
          if (audioBuffer.length >= 10 && !isProcessing) { // Process every 10 chunks
            isProcessing = true;
            
            console.log(`🎤 Processing ${audioBuffer.length} audio chunks...`);
            
            // Send all buffered audio
            for (const audioChunk of audioBuffer) {
              client.realtime.send("input_audio_buffer.append", {
                audio: audioChunk
              });
            }
            
            // Commit to trigger processing
            console.log("🔔 Committing audio buffer...");
            client.realtime.send("input_audio_buffer.commit", {});
            
            // Clear buffer
            audioBuffer = [];
            isProcessing = false;
          }
        }
        
      } catch (e) {
        console.error("Error processing message:", e);
        isProcessing = false;
      }
    });

    // Send ready signal to client
    ws.send(JSON.stringify({ type: "ready", status: "connected" }));

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
