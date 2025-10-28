import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// === Configuration ===
const PORT = process.env.PORT || 8080;
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "UgBBYS2sOqTuMpoF3BR0";

if (!ELEVEN_API_KEY) console.error("❌ Missing ELEVEN_API_KEY!");
if (!OPENAI_API_KEY) console.error("❌ Missing OPENAI_API_KEY!");
if (!ACCOUNT_SID || !AUTH_TOKEN) console.error("❌ Missing Twilio credentials!");

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use("/audio", express.static(AUDIO_DIR));

// Domain + WebSocket URL
const DOMAIN =
  (process.env.RENDER_EXTERNAL_URL || "ai-voice-server.onrender.com").replace(/^https?:\/\//, "");
const WS_URL = `wss://${DOMAIN}/media`;

// === TwiML endpoint ===
app.post("/api/phone/twiml", (req, res) => {
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${DOMAIN}/media" track="inbound_audio" />
  </Start>
  <Say>Hi! I’m your AI assistant. You can start talking now.</Say>
  <Pause length="120"/>
</Response>`;
  res.type("text/xml").send(xmlResponse);
});

// === WebSocket server for Media Streams ===
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Media Stream connected");
  let callSid = null;

  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case "start":
        callSid = msg.start.callSid;
        console.log(`📞 Call started: ${callSid}`);
        break;

      case "media":
        try {
          const audioBase64 = msg.media.payload;
          const audioBuffer = Buffer.from(audioBase64, "base64");

          // --- 1️⃣ STT (ElevenLabs) ---
          const sttRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
            method: "POST",
            headers: {
              "xi-api-key": ELEVEN_API_KEY,
              "Content-Type": "audio/wav",
            },
            body: audioBuffer,
          });

          const sttData = await sttRes.json();
          const text = sttData.text?.trim();
          if (!text) return;
          console.log(`🎙️ User said: ${text}`);

          // --- 2️⃣ GPT response ---
          const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: "You are a friendly and concise voice AI." },
                { role: "user", content: text },
              ],
            }),
          });

          const gptData = await gptRes.json();
          const reply = gptData?.choices?.[0]?.message?.content || "Sorry, I didn’t catch that.";
          console.log("🤖 GPT replied:", reply);

          // --- 3️⃣ TTS (ElevenLabs) ---
          const ttsRes = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`,
            {
              method: "POST",
              headers: {
                "xi-api-key": ELEVEN_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                text: reply,
                model_id: "eleven_monolingual_v3",
              }),
            }
          );

          const ttsBuffer = Buffer.from(await ttsRes.arrayBuffer());
          const filename = `${callSid}-${Date.now()}.mp3`;
          const filePath = path.join(AUDIO_DIR, filename);
          fs.writeFileSync(filePath, ttsBuffer);

          const fileUrl = `https://${DOMAIN}/audio/${filename}`;
          console.log(`🔊 Generated reply audio: ${fileUrl}`);

          // --- 4️⃣ Send Play command to Twilio ---
          const playRes = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${callSid}/Play.json`,
            {
              method: "POST",
              headers: {
                Authorization:
                  "Basic " + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64"),
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ url: fileUrl }),
            }
          );

          if (playRes.ok) {
            console.log(`🎧 Twilio is now playing reply to ${callSid}`);
          } else {
            const errTxt = await playRes.text();
            console.error("❌ Failed to play audio:", errTxt);
          }
        } catch (err) {
          console.error("❌ Error in media pipeline:", err);
        }
        break;

      case "stop":
        console.log("🛑 Stream stopped:", callSid);
        break;
    }
  });
});

// === HTTP + WS upgrade ===
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Twilio Media Stream URL: ${WS_URL}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});
