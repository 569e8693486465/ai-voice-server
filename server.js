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

wss.on("connection", (ws) => {
  console.log("🟢 Client connected");

  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
    headers: {
      Authorization: "Bearer " + OPENAI_API_KEY,
    },
  });

  const messageQueue = [];

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI realtime API");
    // Send session config
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
    console.log("✅ Session configuration sent");

    // Flush any queued messages
    while (messageQueue.length) {
      const data = messageQueue.shift();
      openaiWs.send(data);
    }
  });

  openaiWs.on("message", (data) => {
    try {
      const event = JSON.parse(data);

      // If this is an audio chunk event, forward immediately
      if (event.type === "response.output_audio.delta" && event.delta) {
        ws.send(JSON.stringify({
          type: "audio_chunk",
          delta: event.delta
        }));
        // Optionally send transcript delta separately
      }
      else if (event.type === "response.output_audio_transcript.delta" && event.delta) {
        // Relay transcript deltas for live captioning
        ws.send(JSON.stringify({
          type: "transcript_delta",
          delta: event.delta
        }));
      }
      else if (event.type === "response.done") {
        // Signal that the assistant response is done
        ws.send(JSON.stringify({ type: "response_done" }));
      }
      else {
        // Forward any other events
        ws.send(JSON.stringify(event));
      }
    } catch (err) {
      console.error("Error parsing OpenAI message:", err);
    }
  });

  openaiWs.on("error", (err) => {
    console.error("🔴 OpenAI WebSocket error:", err);
  });

  openaiWs.on("close", () => {
    console.log("🔴 OpenAI connection closed");
    ws.close();
  });

  ws.on("message", (data) => {
    if (openaiWs.readyState !== WebSocket.OPEN) {
      messageQueue.push(data);
    } else {
      try {
        const event = JSON.parse(data);
        // Directly forward the client events to OpenAI
        openaiWs.send(JSON.stringify(event));
      } catch (err) {
        console.error("Error parsing client message:", err);
      }
    }
  });

  ws.on("close", () => {
    console.log("🔴 Client disconnected");
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
});

console.log(`WebSocket server listening on port ${PORT}`);
