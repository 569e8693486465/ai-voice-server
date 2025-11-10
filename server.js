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
app.use(express.static("public")); // serve your index.html from /public

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", async (ws) => {
  console.log("🟢 Client connected");

  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

  client.realtime.on("server.*", (event) => {
    ws.send(JSON.stringify(event));
  });

  client.realtime.on("close", () => ws.close());

  await client.connect();
  console.log("✅ Connected to OpenAI Realtime");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "input_audio_buffer.append" || msg.type === "input_audio_buffer.commit") {
        client.realtime.send(msg.type, msg);
      }
    } catch (e) {
      console.error("Error parsing message:", e);
    }
  });

  ws.on("close", () => client.disconnect());
});
