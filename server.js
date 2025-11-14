import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Load your credentials from .env file
const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
const REPLICA_ID = process.env.REPLICA_ID || "r92debe21318";
const PERSONA_ID = process.env.PERSONA_ID;

// Validate required environment variables
if (!TAVUS_API_KEY) {
  console.error("❌ Missing TAVUS_API_KEY in .env file");
  process.exit(1);
}

if (!PERSONA_ID) {
  console.error("❌ Missing PERSONA_ID in .env file");
  console.log("💡 Create a persona first using the curl command provided in the instructions");
  process.exit(1);
}

app.use(express.json());
app.use(express.static("public"));

// Store active conversations
const activeConversations = new Map();

// Endpoint to create a Tavus conversation
app.post("/create-meeting", async (req, res) => {
  try {
    console.log("🔄 Creating Tavus conversation...");
    
    const response = await fetch("https://tavusapi.com/v2/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TAVUS_API_KEY,
      },
      body: JSON.stringify({
        replica_id: REPLICA_ID,
        persona_id: PERSONA_ID,
        conversation_name: "AI Meeting Assistant",
        conversational_context: "You are an AI assistant participating in a Google Meet meeting. Provide helpful, concise responses.",
        audio_only: false,
        custom_greeting: "Hello everyone! I'm your AI assistant, ready to help with the discussion.",
        callback_url: `${getServerUrl()}/webhook/tavus-callback`,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Tavus API error:", errorText);
      throw new Error(`Tavus API error: ${response.status} - ${errorText}`);
    }

    const conversationData = await response.json();
    console.log("✅ Conversation created:", conversationData.conversation_id);
    
    // Store the conversation
    activeConversations.set(conversationData.conversation_id, {
      conversationId: conversationData.conversation_id,
      conversationUrl: conversationData.conversation_url,
      createdAt: new Date(),
      status: conversationData.status
    });

    res.json({
      success: true,
      meetingUrl: conversationData.conversation_url,
      conversationId: conversationData.conversation_id,
      status: conversationData.status
    });

  } catch (error) {
    console.error("❌ Error creating meeting:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Get conversation status
app.get("/conversation/:id", async (req, res) => {
  try {
    const conversationId = req.params.id;
    const conversation = activeConversations.get(conversationId);
    
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.json({
      conversationId: conversation.conversationId,
      conversationUrl: conversation.conversationUrl,
      status: conversation.status,
      createdAt: conversation.createdAt
    });

  } catch (error) {
    console.error("Error getting conversation:", error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint for Tavus callbacks
app.post("/webhook/tavus-callback", express.json(), (req, res) => {
  console.log("📨 Received Tavus webhook:", JSON.stringify(req.body, null, 2));
  
  const event = req.body;
  
  // Handle different webhook events
  switch (event.type) {
    case "conversation.started":
      console.log("🎉 Conversation started:", event.conversation_id);
      break;
    case "conversation.ended":
      console.log("🔚 Conversation ended:", event.conversation_id);
      activeConversations.delete(event.conversation_id);
      break;
    case "participant.joined":
      console.log("👤 Participant joined:", event.participant_id);
      break;
    case "participant.left":
      console.log("👋 Participant left:", event.participant_id);
      break;
    case "transcription":
      console.log("🗣️ Transcription:", event.text);
      break;
    default:
      console.log("📝 Unknown webhook type:", event.type);
  }
  
  res.sendStatus(200);
});

// Webhook endpoint for Recall.ai
app.post("/webhook/recall", express.json(), (req, res) => {
  console.log("📝 Received Recall.ai webhook:", JSON.stringify(req.body, null, 2));
  // Process Recall.ai transcription here
  res.sendStatus(200);
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    activeConversations: activeConversations.size
  });
});

// Get server info
app.get("/info", (req, res) => {
  res.json({
    replicaId: REPLICA_ID,
    personaId: PERSONA_ID,
    serverUrl: getServerUrl(),
    hasApiKey: !!TAVUS_API_KEY
  });
});

function getServerUrl() {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  }
  return `http://localhost:${PORT}`;
}

app.listen(PORT, () => {
  console.log(`🚀 Tavus AI Meeting Server running on port ${PORT}`);
  console.log(`🔑 Using Replica ID: ${REPLICA_ID}`);
  console.log(`👤 Using Persona ID: ${PERSONA_ID}`);
  console.log(`🌐 Server URL: ${getServerUrl()}`);
  console.log(`💡 Make sure you have created a persona with pipeline_mode: "echo" for LiveKit compatibility`);
});
