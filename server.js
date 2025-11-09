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

// מגיש את public/
app.use(express.static("public"));

// יוצר HTTP server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// יוצר WebSocket על אותו server
const wss = new WebSocketServer({ server });

wss.on("connection", async (ws) => {
  console.log("🟢 Client connected");

  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

  // מהשרת ללקוח (index.html)
  client.realtime.on("server.*", (event) => {
    ws.send(JSON.stringify(event));
  });

  client.realtime.on("close", () => {
    ws.close();
  });

  // מהלקוח ל־OpenAI Realtime
  const messageQueue = [];
  const handleMessage = (data) => {
    try {
      const event = JSON.parse(data);
      client.realtime.send(event.type, event);
    } catch (e) {
      console.error("Error parsing message:", e);
    }
  };

  ws.on("message", (data) => {
    if (!client.isConnected()) {
      messageQueue.push(data);
    } else {
      handleMessage(data);
    }
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
