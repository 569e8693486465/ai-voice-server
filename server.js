import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 3000;
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const AVATAR_ID = process.env.AVATAR_ID || "Wayne_20240711"; // Default avatar

if (!HEYGEN_API_KEY) {
  console.error("Missing HEYGEN_API_KEY in .env");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Store active sessions
const activeSessions = new Map();

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🟢 Client connected to avatar server");
  
  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data);
      
      if (message.type === "start_avatar") {
        await startHeyGenSession(ws, message.avatarId);
      }
      else if (message.type === "stop_avatar") {
        await stopHeyGenSession(ws);
      }
      else if (message.type === "user_speech") {
        await sendTextToAvatar(ws, message.text, message.taskType || "talk");
      }
      
    } catch (error) {
      console.error("Error handling client message:", error);
      ws.send(JSON.stringify({
        type: "error",
        message: error.message
      }));
    }
  });

  ws.on("close", () => {
    console.log("🔴 Client disconnected");
    // Clean up any active session for this client
    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.client === ws) {
        stopHeyGenSession(ws);
        break;
      }
    }
  });
});

// Webhook endpoint for Recall.ai to send transcribed speech
app.post("/webhook/recall-transcription", async (req, res) => {
  try {
    console.log("📝 Received transcription from Recall.ai:", req.body);
    
    // Extract transcription from Recall.ai webhook
    // This structure might vary - adjust based on Recall.ai's actual webhook format
    const transcription = req.body.transcript || req.body.text;
    const meetingId = req.body.meeting_id;
    
    if (!transcription) {
      return res.status(400).send("No transcription found");
    }

    // Find active session for this meeting and send text to avatar
    for (const [sessionId, session] of activeSessions.entries()) {
      // In a real app, you'd map meetingId to sessionId
      await sendTextToAvatar(session.client, transcription, "talk");
      break;
    }

    res.status(200).send("Transcription processed");
    
  } catch (error) {
    console.error("Error processing Recall.ai webhook:", error);
    res.status(500).send("Internal server error");
  }
});

// Endpoint to manually test avatar (without Recall.ai)
app.post("/api/speak", async (req, res) => {
  try {
    const { text, taskType = "talk" } = req.body;
    
    if (!text) {
      return res.status(400).send("Text is required");
    }

    // Send to first active session (in real app, you'd specify which session)
    for (const [sessionId, session] of activeSessions.entries()) {
      await sendTextToAvatar(session.client, text, taskType);
      break;
    }

    res.status(200).send("Text sent to avatar");
    
  } catch (error) {
    console.error("Error in /api/speak:", error);
    res.status(500).send("Internal server error");
  }
});

// Start HeyGen session
async function startHeyGenSession(ws, avatarId = AVATAR_ID) {
  try {
    console.log("🔄 Starting HeyGen session...");
    
    // Create new session
    const sessionResponse = await fetch("https://api.heygen.com/v1/streaming.new", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HEYGEN_API_KEY}`
      },
      body: JSON.stringify({
        quality: "high",
        avatar_name: avatarId,
        voice: {
          voice_id: "", // HeyGen will use default voice
          rate: 1.0,
        },
        version: "v2",
        video_encoding: "H264"
      })
    });

    if (!sessionResponse.ok) {
      throw new Error(`HeyGen API error: ${await sessionResponse.text()}`);
    }

    const sessionData = await sessionResponse.json();
    const sessionInfo = sessionData.data;
    
    console.log("✅ HeyGen session created:", sessionInfo.session_id);

    // Start streaming
    const startResponse = await fetch("https://api.heygen.com/v1/streaming.start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HEYGEN_API_KEY}`
      },
      body: JSON.stringify({
        session_id: sessionInfo.session_id
      })
    });

    if (!startResponse.ok) {
      throw new Error(`HeyGen start error: ${await startResponse.text()}`);
    }

    // Store session info
    activeSessions.set(sessionInfo.session_id, {
      client: ws,
      sessionId: sessionInfo.session_id,
      createdAt: new Date()
    });

    // Send LiveKit info to client
    ws.send(JSON.stringify({
      type: "heygen_session_created",
      sessionId: sessionInfo.session_id,
      livekitUrl: sessionInfo.url,
      livekitToken: sessionInfo.access_token
    }));

  } catch (error) {
    console.error("Error starting HeyGen session:", error);
    ws.send(JSON.stringify({
      type: "error",
      message: `Failed to start avatar: ${error.message}`
    }));
  }
}

// Stop HeyGen session
async function stopHeyGenSession(ws) {
  try {
    let sessionToStop = null;
    
    // Find session for this client
    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.client === ws) {
        sessionToStop = session;
        break;
      }
    }

    if (!sessionToStop) {
      console.log("No active session found for client");
      return;
    }

    console.log("🛑 Stopping HeyGen session:", sessionToStop.sessionId);
    
    const stopResponse = await fetch("https://api.heygen.com/v1/streaming.stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HEYGEN_API_KEY}`
      },
      body: JSON.stringify({
        session_id: sessionToStop.sessionId
      })
    });

    activeSessions.delete(sessionToStop.sessionId);
    
    ws.send(JSON.stringify({
      type: "heygen_session_stopped"
    }));

    console.log("✅ HeyGen session stopped");

  } catch (error) {
    console.error("Error stopping HeyGen session:", error);
  }
}

// Send text to avatar
async function sendTextToAvatar(ws, text, taskType = "talk") {
  try {
    let targetSession = null;
    
    // Find session for this client
    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.client === ws) {
        targetSession = session;
        break;
      }
    }

    if (!targetSession) {
      throw new Error("No active avatar session found");
    }

    console.log(`🗣️ Sending text to avatar (${taskType}):`, text.substring(0, 50) + "...");
    
    const taskResponse = await fetch("https://api.heygen.com/v1/streaming.task", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HEYGEN_API_KEY}`
      },
      body: JSON.stringify({
        session_id: targetSession.sessionId,
        text: text,
        task_type: taskType
      })
    });

    if (!taskResponse.ok) {
      throw new Error(`HeyGen task error: ${await taskResponse.text()}`);
    }

    ws.send(JSON.stringify({
      type: "text_sent_to_avatar",
      text: text,
      taskType: taskType
    }));

  } catch (error) {
    console.error("Error sending text to avatar:", error);
    ws.send(JSON.stringify({
      type: "error", 
      message: `Failed to send text: ${error.message}`
    }));
  }
}

console.log(`🤖 HeyGen Avatar Server ready on port ${PORT}`);
