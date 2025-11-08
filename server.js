import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Use JSON middleware (Recall sends JSON webhooks)
app.use(express.json({ limit: "10mb" }));

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const SHARED_SECRET = process.env.SHARED_SECRET;

if (!OPENAI_API_KEY || !HEYGEN_API_KEY || !SHARED_SECRET) {
  console.error("❌ Missing required environment variables!");
  process.exit(1);
}

// 🧩 Create a new HeyGen streaming session
async function createHeygenSession() {
  console.log("🟡 Creating new HeyGen session...");
  const response = await fetch("https://api.heygen.com/v1/streaming.create_session", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HEYGEN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      avatar_name: "Pedro_Chair_Sitting_public",
      quality: "high",
      background: "transparent",
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("❌ HeyGen session creation failed:", data);
    throw new Error("Failed to create HeyGen session");
  }

  console.log("✅ HeyGen session created:", data.data.session_id);
  return {
    session_id: data.data.session_id,
    stream_url: data.data.stream_url,
  };
}

// ✅ Health check
app.get("/", (req, res) => {
  res.send("🤖 AI Avatar Server (Transcript Mode) is running!");
});

// 🎯 Main webhook: triggered by Recall.ai on real-time transcript
app.post("/recall-audio", async (req, res) => {
  // 🔒 Verify shared secret
  const secret = req.headers["x-shared-secret"];
  if (secret !== SHARED_SECRET) {
    console.warn("🚫 Unauthorized webhook attempt");
    return res.status(403).json({ error: "Invalid shared secret" });
  }

  // 💬 Handle transcript events only
  if (req.body.event_type === "transcript") {
    const text = req.body.payload?.text?.trim();
    const speaker = req.body.payload?.speaker || "Unknown";

    console.log(`🗣️ [${speaker}]: ${text}`);

    // Skip if empty or too short
    if (!text || text.length < 3) {
      return res.status(200).send("Ignored: too short");
    }

    try {
      // 🤖 Generate AI reply with GPT (in Hebrew)
      const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "אתה 'פדרו', דמות וידאו וירטואלית חמה, מספקת, ומדברת בעברית טבעית וקולחת. תענה בקצרה ובצורה ידידותית.",
            },
            {
              role: "user",
              content: text,
            },
          ],
          temperature: 0.7,
        }),
      });

      const gptData = await gptResponse.json();
      const reply = gptData.choices?.[0]?.message?.content?.trim() || "אהה, כן! בוא נדבר על זה.";

      console.log("💬 GPT Reply:", reply);

      // 🎥 Create HeyGen session and speak
      const { session_id } = await createHeygenSession();

      const speakResponse = await fetch("https://api.heygen.com/v1/streaming.start_speaking", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HEYGEN_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id,
          text: reply,
        }),
      });

      if (!speakResponse.ok) {
        const err = await speakResponse.json();
        console.error("❌ HeyGen speak failed:", err);
      } else {
        console.log("🎬 HeyGen speaking triggered successfully");
      }

      res.json({ status: "ok", reply, speaker });
    } catch (error) {
      console.error("💥 Error processing transcript:", error);
      res.status(500).json({ error: "Processing failed" });
    }
  } else {
    // Ignore other event types
    console.log("⏭️ Ignored event type:", req.body.event_type);
    res.status(200).send("OK");
  }
});

// 🚀 Start server
app.listen(PORT, () => {
  console.log(`🚀 AI Avatar server running on port ${PORT}`);
  console.log(`🔗 Webhook URL: https://avatar-server-yp11.onrender.com/recall-audio`);
});
