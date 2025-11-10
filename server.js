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

  client.realtime.on("server.*", (event) => ws.send(JSON.stringify(event)));
  client.realtime.on("close", () => ws.close());

  const messageQueue = [];

  ws.on("message", (data) => {
    if (!client.isConnected()) messageQueue.push(data);
    else handleMessage(data);
  });

  ws.on("close", () => client.disconnect());

  const handleMessage = (data) => {
    try {
      const event = JSON.parse(data);
      client.realtime.send(event.type, event);
    } catch (e) {
      console.error("Error parsing message:", e);
    }
  };

  try {
    await client.connect();
    console.log("✅ Connected to OpenAI Realtime");

    // שליחת הודעת בדיקה
    client.sendUserMessageContent([{ type: "input_text", text: "Hello!" }]);
    client.updateSession({ turn_detection: { type: "server_vad" } });

    while (messageQueue.length) handleMessage(messageQueue.shift());
  } catch (e) {
    console.error("Error connecting to OpenAI:", e);
    ws.close();
  }
});
