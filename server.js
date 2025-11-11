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
    console.log("🔸 Connecting to OpenAI Realtime API (GA)...");
    
    // Connect to OpenAI GA API
    const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
      headers: {
        Authorization: "Bearer " + OPENAI_API_KEY,
      },
    });

    let audioBuffer = [];
    let isCollectingAudio = false;
    let commitTimer = null;

    openaiWs.on("open", function open() {
      console.log("✅ Connected to OpenAI Realtime API");
      
      // Configure session using CORRECT GA API format
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions: "You are a helpful meeting assistant. Respond briefly and conversationally. Keep responses under 10 words.",
          modalities: ["text", "audio"],
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          temperature: 0.8,
          // CORRECT LOCATION for voice in GA API
          voice: "alloy", // or "shimmer", "coral", "echo", "sage"
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      }));
      console.log("✅ Session configuration sent");
    });

    openaiWs.on("message", function incoming(message) {
      try {
        const event = JSON.parse(message.toString());
        console.log(`🔵 OpenAI Event: ${event.type}`);
        
        // Handle different event types
        switch (event.type) {
          case "session.created":
            console.log("✅ Session created");
            break;
            
          case "session.updated":
            console.log("✅ Session updated");
            // Send ready signal to client
            ws.send(JSON.stringify({ type: "ready", status: "connected" }));
            break;
            
          case "response.output_audio.delta":
            console.log("🔊 AI Audio Response Delta - Length:", event.delta?.length || 0);
            // Forward audio to client
            ws.send(JSON.stringify({
              type: "response.output_audio.delta",
              delta: event.delta
            }));
            break;
            
          case "response.output_audio_transcript.delta":
            console.log("💬 AI Transcript:", event.delta);
            // Forward transcript to client
            ws.send(JSON.stringify({
              type: "response.output_audio_transcript.delta", 
              delta: event.delta
            }));
            break;
            
          case "response.done":
            console.log("✅ Response completed");
            break;
            
          case "error":
            console.error("🔴 OpenAI Error:", event.error);
            if (event.error.code !== 'input_audio_buffer_commit_empty') {
              ws.send(JSON.stringify({ type: "error", error: event.error.message }));
            }
            break;
            
          default:
            // Forward other important events
            if (event.type.includes('response') || event.type.includes('error')) {
              ws.send(JSON.stringify(event));
            }
        }
      } catch (error) {
        console.error("Error parsing OpenAI message:", error);
      }
    });

    openaiWs.on("error", function error(err) {
      console.error("🔴 OpenAI WebSocket error:", err);
      ws.send(JSON.stringify({ type: "error", error: "OpenAI connection failed" }));
    });

    openaiWs.on("close", function close() {
      console.log("🔴 OpenAI WebSocket closed");
    });

    // Handle messages from client (meeting audio)
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        
        if (msg.type === "meeting_audio" && openaiWs.readyState === WebSocket.OPEN) {
          // Add audio to buffer
          audioBuffer.push(msg.audio);
          
          // Start collecting if not already
          if (!isCollectingAudio) {
            isCollectingAudio = true;
            console.log("🎤 Started collecting audio...");
          }
          
          // Clear any existing timer
          if (commitTimer) clearTimeout(commitTimer);
          
          // Wait until we have enough audio (at least 15 chunks = ~300ms)
          if (audioBuffer.length >= 15) {
            console.log(`🎤 Collected ${audioBuffer.length} audio chunks, sending to OpenAI...`);
            
            // Send all buffered audio
            for (const audioChunk of audioBuffer) {
              openaiWs.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: audioChunk
              }));
            }
            
            // Commit the audio
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.commit",
            }));
            
            console.log("🔔 Audio buffer committed");
            
            // Reset buffer
            audioBuffer = [];
            isCollectingAudio = false;
          } else {
            // Set timer to commit after timeout (force commit after 2 seconds)
            commitTimer = setTimeout(() => {
              if (audioBuffer.length > 0) {
                console.log(`🎤 Timeout - committing ${audioBuffer.length} audio chunks...`);
                
                // Send all buffered audio
                for (const audioChunk of audioBuffer) {
                  openaiWs.send(JSON.stringify({
                    type: "input_audio_buffer.append",
                    audio: audioChunk
                  }));
                }
                
                // Commit the audio
                openaiWs.send(JSON.stringify({
                  type: "input_audio_buffer.commit",
                }));
                
                console.log("🔔 Audio buffer committed (timeout)");
                audioBuffer = [];
                isCollectingAudio = false;
              }
            }, 2000);
          }
        }
        
      } catch (e) {
        console.error("Error processing client message:", e);
      }
    });

    // Clean up on client disconnect
    ws.on("close", () => {
      console.log("🔴 Client WebSocket closed");
      if (commitTimer) clearTimeout(commitTimer);
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

  } catch (error) {
    console.error("❌ Failed to setup OpenAI:", error);
    ws.send(JSON.stringify({ 
      type: "error", 
      error: "Setup failed: " + error.message 
    }));
  }
});
