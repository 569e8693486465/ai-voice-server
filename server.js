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
    let commitTimer = null;
    let isSpeaking = false;

    openaiWs.on("open", function open() {
      console.log("✅ Connected to OpenAI Realtime API");
      
      // Configure session using CORRECT GA API format
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions: "You are a helpful meeting assistant. Keep responses very brief - 1-2 sentences maximum. Respond conversationally.",
          voice: "alloy", // Correct location in GA API
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          temperature: 0.7,
          turn_detection: {
            type: "server_vad",
            threshold: 0.3, // Lower threshold for faster detection
            prefix_padding_ms: 200, // Reduced padding
            silence_duration_ms: 400 // Shorter silence detection
          }
        }
      }));
      console.log("✅ Session configuration sent");
    });

    openaiWs.on("message", function incoming(message) {
      try {
        const event = JSON.parse(message.toString());
        
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
            console.log("🔊 AI Audio Response - Length:", event.delta?.length || 0);
            isSpeaking = true;
            // Forward audio to client
            ws.send(JSON.stringify({
              type: "response.output_audio.delta",
              delta: event.delta
            }));
            break;
            
          case "response.output_audio_transcript.delta":
            console.log("💬 AI:", event.delta);
            // Forward transcript to client
            ws.send(JSON.stringify({
              type: "response.output_audio_transcript.delta", 
              delta: event.delta
            }));
            break;
            
          case "response.done":
            console.log("✅ Response completed");
            isSpeaking = false;
            break;
            
          case "input_audio_buffer.speech_stopped":
            console.log("🎤 Speech stopped detected");
            // Force commit when speech stops
            if (audioBuffer.length > 0) {
              commitAudioBuffer();
            }
            break;
            
          case "error":
            if (event.error.code !== 'input_audio_buffer_commit_empty') {
              console.error("🔴 OpenAI Error:", event.error);
            }
            break;
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

    // Function to commit audio buffer
    function commitAudioBuffer() {
      if (audioBuffer.length === 0 || openaiWs.readyState !== WebSocket.OPEN) return;
      
      console.log(`🔔 Committing ${audioBuffer.length} audio chunks...`);
      
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
      
      // Reset buffer
      audioBuffer = [];
    }

    // Handle messages from client (meeting audio)
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        
        if (msg.type === "meeting_audio" && openaiWs.readyState === WebSocket.OPEN && !isSpeaking) {
          // Add audio to buffer
          audioBuffer.push(msg.audio);
          
          // Clear any existing timer
          if (commitTimer) clearTimeout(commitTimer);
          
          // Commit immediately for faster response (reduced from 15 to 8 chunks)
          if (audioBuffer.length >= 8) {
            commitAudioBuffer();
          } else {
            // Set timer to commit after shorter timeout
            commitTimer = setTimeout(() => {
              if (audioBuffer.length > 3) { // Reduced minimum chunks
                commitAudioBuffer();
              }
            }, 800); // Reduced from 2000ms to 800ms
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
