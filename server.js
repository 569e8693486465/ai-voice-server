import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
const RECALL_API_KEY = process.env.RECALL_API_KEY;
const REPLICA_ID = process.env.REPLICA_ID || "r6ae5b6efc9d";
const PERSONA_ID = process.env.PERSONA_ID;

app.use(express.json());
app.use(express.static("public"));

// Store active conversations
const activeConversations = new Map();

const server = app.listen(PORT, () => {
  console.log(`🚀 Tavus + Recall.ai Integration Server running on port ${PORT}`);
});

// Endpoint to create Tavus conversation and deploy Recall.ai bot
app.post("/deploy-bot", async (req, res) => {
  try {
    const { meeting_url } = req.body;
    
    if (!meeting_url) {
      return res.status(400).json({ error: "Meeting URL is required" });
    }

    console.log("🔄 Creating Tavus conversation...");

    // 1. Create Tavus conversation
    const tavusResponse = await fetch("https://tavusapi.com/v2/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TAVUS_API_KEY,
      },
      body: JSON.stringify({
        replica_id: REPLICA_ID,
        persona_id: PERSONA_ID,
        conversation_name: "AI Meeting Assistant",
        conversational_context: "You are participating in a Google Meet. Provide helpful, concise responses.",
        audio_only: false,
        custom_greeting: "Hello! I'm your AI assistant, ready to help with the discussion.",
      }),
    });

    if (!tavusResponse.ok) {
      throw new Error(`Tavus API error: ${await tavusResponse.text()}`);
    }

    const tavusData = await tavusResponse.json();
    console.log("✅ Tavus conversation created:", tavusData.conversation_id);

    // 2. Deploy Recall.ai bot with the Tavus Daily.co URL
    const botResponse = await fetch("https://us-west-2.recall.ai/api/v1/bot/", {
      method: "POST",
      headers: {
        'Authorization': RECALL_API_KEY,
        'accept': 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        "meeting_url": meeting_url,
        "bot_name": "AI Assistant",
        "output_media": {
          "camera": {
            "kind": "webpage",
            "config": {
              "url": `${getServerUrl()}/bot-interface.html?conversationUrl=${encodeURIComponent(tavusData.conversation_url)}&conversationId=${tavusData.conversation_id}`
            }
          }
        },
        "variant": {
          "google_meet": "web_4_core"
        }
      })
    });

    if (!botResponse.ok) {
      throw new Error(`Recall.ai API error: ${await botResponse.text()}`);
    }

    const botData = await botResponse.json();

    // Store conversation info
    activeConversations.set(tavusData.conversation_id, {
      conversationId: tavusData.conversation_id,
      conversationUrl: tavusData.conversation_url,
      botId: botData.id,
      meetingUrl: meeting_url,
      createdAt: new Date()
    });

    res.json({
      success: true,
      botId: botData.id,
      conversationId: tavusData.conversation_id,
      conversationUrl: tavusData.conversation_url,
      meetingUrl: meeting_url,
      status: "deployed"
    });

  } catch (error) {
    console.error("❌ Error deploying bot:", error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint for Recall.ai transcriptions
app.post("/webhook/recall-transcription", async (req, res) => {
  try {
    console.log("📝 Received Recall.ai transcription:", req.body);
    
    // Extract transcription from Recall.ai webhook
    const transcription = req.body.transcript || req.body.text;
    const botId = req.body.bot_id;
    
    if (!transcription) {
      return res.status(400).send("No transcription found");
    }

    console.log(`🗣️ Processing transcription from bot ${botId}: ${transcription}`);

    // Find the conversation for this bot and forward the transcription
    // In production, you'd send this to the bot interface via WebSocket
    // For now, we'll log it and you can implement the WebSocket forwarding
    
    res.status(200).send("Transcription received");
    
  } catch (error) {
    console.error("Error processing transcription:", error);
    res.status(500).send("Internal server error");
  }
});

function getServerUrl() {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  }
  return `http://localhost:${PORT}`;
}

console.log(`🤖 Server ready! Tavus conversations will use Daily.co sendAppMessage()`);
