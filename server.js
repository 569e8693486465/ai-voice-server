// server.js
import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// מביאים fetch מובנה של Node (Node 18+)
const fetchFn = globalThis.fetch.bind(globalThis);

// בולעני בקשות JSON
app.use(express.json());

// in-memory store (פשוט POC). לשימוש רציני השתמש ב-Redis.
let heygenSession = null; // { session_id, stream_url }
let latestReply = "";
let latestMeta = { time: null };

// --- Utilities ---
function nowISO() {
  return new Date().toISOString();
}

// HMAC validation (אופציונלי): אם תקבע SHARED_SECRET בסביבת הריצה, השרת ידרוש header X-Hook-Signature
import crypto from "crypto";
function verifyHmac(bodyBuffer, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(bodyBuffer).digest("hex");
  // signature may be formatted like: sha256=...
  const sig = signature.startsWith("sha256=") ? signature.split("=", 2)[1] : signature;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// --- Endpoint: create HeyGen session (manual or called automatically) ---
app.post("/create-heygen-session", async (req, res) => {
  try {
    const avatar_id = req.body?.avatar_id || process.env.HEYGEN_AVATAR_ID || null;
    if (!process.env.HEYGEN_API_KEY) return res.status(500).json({ error: "Missing HEYGEN_API_KEY" });
    if (!avatar_id) return res.status(400).json({ error: "Missing avatar_id (body) or HEYGEN_AVATAR_ID env" });

    const response = await fetchFn("https://api.heygen.com/v1/streaming.create_session", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HEYGEN_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        avatar_id,
        quality: "high",
        background: "transparent"
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("HeyGen create_session error:", data);
      return res.status(400).json({ error: "HeyGen error", details: data });
    }

    // שים לב לשדה JSON בהתאם לחזרה של HeyGen
    heygenSession = {
      session_id: data.data?.session_id || data.session_id || null,
      stream_url: data.data?.stream_url || data.stream_url || null
    };

    latestMeta.time = nowISO();
    console.log("✅ Created HeyGen session:", heygenSession);
    return res.json({ ok: true, heygenSession });
  } catch (err) {
    console.error("create-heygen-session error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// --- Endpoint: get current stream URL (for Recall to point camera at) ---
app.get("/stream-url", (req, res) => {
  if (!heygenSession) return res.status(404).json({ error: "No HeyGen session" });
  return res.json({ stream_url: heygenSession.stream_url, session_id: heygenSession.session_id, meta: latestMeta });
});

// --- Endpoint: latest reply (for debugging / avatar page polling) ---
app.get("/latest-reply", (req, res) => {
  return res.json({ reply: latestReply, meta: latestMeta });
});

// --- Core Endpoint: Recall webhook posts audio here ---
// Recall might POST raw audio bytes or multipart/form-data depending on configuration.
// This endpoint expects raw audio bytes (audio/mpeg, audio/wav, etc).
app.post("/recall-audio", bodyParser.raw({ type: ["audio/*", "application/octet-stream"], limit: "80mb" }), async (req, res) => {
  try {
    // Optional: verify HMAC if SHARED_SECRET is set
    const sharedSecret = process.env.SHARED_SECRET || null;
    if (sharedSecret) {
      const sig = req.get("X-Hook-Signature") || req.get("x-hook-signature") || req.get("x-recall-signature");
      if (!verifyHmac(req.body, sig, sharedSecret)) {
        console.warn("❌ Invalid signature on /recall-audio");
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: "No audio body received" });
    }

    console.log("🎧 Received audio bytes from Recall (len:", req.body.length, ")");

    // 0) Ensure we have a HeyGen session (create if missing)
    if (!heygenSession) {
      console.log("ℹ️ No HeyGen session yet — creating one automatically...");
      // call internal create endpoint logic directly to avoid HTTP loop
      const avatar_id = process.env.HEYGEN_AVATAR_ID || null;
      if (!process.env.HEYGEN_API_KEY || !avatar_id) {
        return res.status(500).json({ error: "HEYGEN_API_KEY or HEYGEN_AVATAR_ID missing" });
      }

      const response = await fetchFn("https://api.heygen.com/v1/streaming.create_session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.HEYGEN_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ avatar_id, quality: "high", background: "transparent" }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error("HeyGen auto-create error:", data);
        return res.status(500).json({ error: "HeyGen create failed", details: data });
      }

      heygenSession = {
        session_id: data.data?.session_id || data.session_id,
        stream_url: data.data?.stream_url || data.stream_url
      };
      console.log("✅ Auto-created HeyGen session:", heygenSession);
    }

    // 1) Send audio to ElevenLabs STT
    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(500).json({ error: "Missing ELEVENLABS_API_KEY" });
    }

    const elevenResp = await fetchFn("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": req.get("Content-Type") || "audio/mpeg"
      },
      body: req.body,
    });

    const elevenData = await elevenResp.json();
    // adjust according to ElevenLabs response shape
    const transcript = elevenData.text || elevenData.transcript || (Array.isArray(elevenData) && elevenData[0]?.text) || "";

    console.log("📝 ElevenLabs transcript:", transcript);
    if (!transcript) {
      return res.status(200).json({ ok: true, note: "no-transcript", details: elevenData });
    }

    // 2) Send transcript to OpenAI (chat completion)
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const chatResp = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a friendly avatar assistant. Answer concisely so speech sounds natural." },
          { role: "user", content: transcript }
        ],
        max_tokens: 200
      })
    });

    const chatData = await chatResp.json();
    const aiText = chatData?.choices?.[0]?.message?.content?.trim() || "";

    console.log("🤖 OpenAI reply:", aiText);
    latestReply = aiText;
    latestMeta.time = nowISO();

    if (!aiText) {
      return res.status(200).json({ ok: true, note: "no-ai-text", transcript, chatData });
    }

    // 3) Send the aiText to HeyGen to speak on the existing session
    if (!process.env.HEYGEN_API_KEY) return res.status(500).json({ error: "Missing HEYGEN_API_KEY" });

    const heygenSpeakResp = await fetchFn("https://api.heygen.com/v1/streaming.speak", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HEYGEN_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: heygenSession.session_id,
        text: aiText,
        // optionally: voice, speed, etc
      }),
    });

    const heygenSpeakData = await heygenSpeakResp.json();
    console.log("🦾 HeyGen speak response:", heygenSpeakData);

    // respond quickly to Recall
    return res.json({
      ok: true,
      transcript,
      aiText,
      heygen: heygenSpeakData,
      stream_url: heygenSession.stream_url
    });
  } catch (err) {
    console.error("/recall-audio error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// Health
app.get("/", (req, res) => res.send("✅ Server running"));

// start
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: NODE_ENV=${process.env.NODE_ENV || "development"}`);
});
