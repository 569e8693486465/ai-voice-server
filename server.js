import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
const RECALL_API_KEY = process.env.RECALL_API_KEY;
const REPLICA_ID = process.env.REPLICA_ID || "r92debe21318";
const PERSONA_ID = process.env.PERSONA_ID;

if (!TAVUS_API_KEY || !RECALL_API_KEY || !PERSONA_ID) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

app.use(express.json());
app.use(express.static("public"));

// Store active conversations
const activeConversations = new Map();

const server = app.listen(PORT, () => {
  console.log(`🚀 Tavus + Recall.ai Integration Server running on port ${PORT}`);
});

// WebSocket server for real-time transcriptions
const wss = new WebSocketServer({ 
  server: server,
  path: '/transcriptions'
});

// Store WebSocket connections
const transcriptionConnections = new Map();

wss.on('connection', (ws, req) => {
  console.log('🟢 Transcription WebSocket connected');
  
  const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const conversationId = urlParams.get('conversationId');
  
  if (conversationId) {
    transcriptionConnections.set(conversationId, ws);
    console.log(`📡 WebSocket registered for conversation: ${conversationId}`);
  }

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log('📨 Received WebSocket message:', message);
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });

  ws.on('close', () => {
    console.log('🔴 Transcription WebSocket disconnected');
    transcriptionConnections.forEach((connection, id) => {
      if (connection === ws) {
        transcriptionConnections.delete(id);
      }
    });
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Function to send transcription to specific conversation
function sendTranscriptionToConversation(conversationId, text) {
  const ws = transcriptionConnections.get(conversationId);
  if (ws && ws.readyState === 1) {
    const message = {
      type: 'transcription',
      text: text,
      conversationId: conversationId,
      timestamp: new Date().toISOString()
    };
    ws.send(JSON.stringify(message));
    console.log(`📤 Sent transcription to conversation ${conversationId}: ${text}`);
    return true;
  } else {
    console.log(`❌ No WebSocket connection for conversation ${conversationId}`);
    return false;
  }
}

// Endpoint to create Tavus conversation and deploy Recall.ai bot to Google Meet
app.post("/deploy-to-google-meet", async (req, res) => {
  try {
    const { meeting_url } = req.body;
    
    if (!meeting_url) {
      return res.status(400).json({ error: "Google Meet URL is required" });
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

    // 2. Deploy Recall.ai bot to join Google Meet with Tavus avatar
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
              "url": `${getServerUrl()}/google-meet-interface.html?conversationUrl=${encodeURIComponent(tavusData.conversation_url)}&conversationId=${tavusData.conversation_id}`
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
      meetingUrl: meeting_url,
      status: "deployed",
      message: "AI avatar is joining your Google Meet!"
    });

  } catch (error) {
    console.error("❌ Error deploying bot:", error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint for Recall.ai transcriptions
app.post("/webhook/recall-transcription", async (req, res) => {
  try {
    const event = req.body;
    console.log("📨 Received Recall.ai webhook:", event.type);
    
    // Handle different webhook event types
    switch (event.type) {
      case 'transcript.done':
        await handleTranscriptDone(event);
        break;
        
      case 'transcript.processing':
        await handleTranscriptProcessing(event);
        break;
        
      case 'bot.joining_call':
        console.log('🔄 Bot is joining Google Meet:', event.data?.bot?.id);
        break;
        
      case 'bot.in_call_recording':
        console.log('🎥 Bot is recording Google Meet');
        break;
        
      case 'bot.call_ended':
        console.log('🔚 Bot left Google Meet');
        break;
        
      default:
        console.log('📝 Other webhook event:', event.type);
    }

    res.status(200).send("Webhook processed");
    
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal server error");
  }
});

// Handle completed transcriptions from Google Meet
async function handleTranscriptDone(event) {
  const transcript = event.data?.transcript;
  const botId = event.data?.bot?.id;
  
  if (!transcript || !transcript.sentences) {
    console.log('❌ No transcript sentences found');
    return;
  }

  console.log(`📝 Transcript COMPLETED from Google Meet for bot ${botId}`);
  
  // Get all sentences from the transcript
  const sentences = transcript.sentences
    .filter(s => s.text && s.text.trim())
    .map(s => s.text.trim());
  
  if (sentences.length === 0) {
    console.log('❌ No text content in transcript');
    return;
  }

  // Use the last few sentences (most recent speech)
  const recentText = sentences.slice(-2).join(' ');
  console.log(`🗣️ Recent transcription from Google Meet: "${recentText}"`);

  // Find conversation for this bot and send transcription to Tavus
  for (const [conversationId, session] of activeConversations.entries()) {
    if (session.botId === botId) {
      const success = sendTranscriptionToConversation(conversationId, recentText);
      if (success) {
        console.log(`✅ Forwarded Google Meet transcription to Tavus conversation ${conversationId}`);
      }
      break;
    }
  }
}

// Handle processing transcriptions (real-time)
async function handleTranscriptProcessing(event) {
  const transcript = event.data?.transcript;
  const botId = event.data?.bot?.id;
  
  if (!transcript || !transcript.sentences) {
    return;
  }

  const sentences = transcript.sentences
    .filter(s => s.text && s.text.trim())
    .map(s => s.text.trim());
  
  if (sentences.length === 0) return;

  const latestText = sentences[sentences.length - 1];
  console.log(`🔄 Google Meet transcription PROCESSING: "${latestText}"`);

  for (const [conversationId, session] of activeConversations.entries()) {
    if (session.botId === botId) {
      sendTranscriptionToConversation(conversationId, latestText);
      break;
    }
  }
}

// Test endpoint to simulate transcriptions
app.post("/send-test-message", async (req, res) => {
  try {
    const { conversationId, text } = req.body;
    
    if (!conversationId || !text) {
      return res.status(400).json({ error: 'conversationId and text are required' });
    }

    console.log(`🧪 Test message for ${conversationId}: ${text}`);
    
    const success = sendTranscriptionToConversation(conversationId, text);
    
    res.json({
      success: success,
      message: success ? 'Test message sent' : 'No active WebSocket connection'
    });

  } catch (error) {
    console.error('Error sending test message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    activeConversations: activeConversations.size,
    websocketConnections: transcriptionConnections.size
  });
});

function getServerUrl() {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  }
  return `http://localhost:${PORT}`;
}

console.log(`🤖 Google Meet Integration Server ready!`);
console.log(`📡 WebSocket server running on /transcriptions`);
