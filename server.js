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
app.use(express.static("public")); // משרת את public/

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", async (ws) => {
  console.log("🟢 Client connected");

  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

  // שליחת כל אירוע מה־Realtime ללקוח
  client.realtime.on("server.*", (event) => {
    ws.send(JSON.stringify(event));
  });

  client.realtime.on("close", () => ws.close());

  const messageQueue = [];

  const handleMessage = (data) => {
    try {
      const event = JSON.parse(data);
      client.realtime.send(event.type, event);

      // ברגע שהלקוח סיים לשלוח אודיו, תבקש תגובה קולית
      if (event.type === "input_audio_buffer.commit") {
        client.realtime.send("response.create", {
          instructions: "You are a helpful assistant. Respond in audio.",
          modalities: ["audio"],
        });
      }
    } catch (e) {
      console.error("Error parsing message:", e);
    }
  };

  ws.on("message", (data) => {
    if (!client.isConnected()) messageQueue.push(data);
    else handleMessage(data);
  });

  ws.on("close", () => client.disconnect());

  try {
    await client.connect();
    console.log("✅ Connected to OpenAI Realtime");

    while (messageQueue.length) {
      handleMessage(messageQueue.shift());
    }
  } catch (e) {
    console.error("Error connecting to OpenAI:", e);
    ws.close();
  }
});
