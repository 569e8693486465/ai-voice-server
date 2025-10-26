# AI Voice Server (Render-ready ZIP)

This package contains a minimal Node.js Web Service that:
- Serves a TwiML endpoint `/api/phone/twiml` which returns a ConversationRelay URL (WebSocket)
- Accepts WebSocket upgrades on `/api/phone/ws` (used by Twilio ConversationRelay)
- For incoming text messages from Twilio, attempts to call Google Gemini (if `GOOGLE_API_KEY` is set)

## Files
- `server.js` - main server implementation
- `package.json` - dependencies & start command
- `.env.example` - example env file for local testing

## Quick deploy to Render (manual ZIP upload)
1. In Render dashboard: **New → Web Service → Manual Deploy** (upload ZIP).
2. Upload this ZIP (ai-voice-server.zip).
3. Environment: **Node**
4. Build Command: `npm install`
5. Start Command: `npm start`
6. AFTER deploy completes, set environment variable `GOOGLE_API_KEY` in the Render service settings (do NOT put API keys in the UI or code publicly).
   - Render typically exposes `RENDER_EXTERNAL_URL` which the server uses to build the `wss://` URL for Twilio.
7. In your V0 project set `NEXT_PUBLIC_BASE_URL` to `https://<your-render-service>.onrender.com`.
8. In Twilio (or your frontend), ensure the TwiML URL points to `https://<your-render-service>.onrender.com/api/phone/twiml`.

## Notes
- This package uses a best-effort lazy import of `@google/generative-ai`. Depending on the package version the runtime methods may vary.
- For production use, secure Twilio credentials in Render environment variables and use the Twilio SDK to create calls server-side.
- If you need, I can build a version that uses the Twilio SDK to initiate calls directly (requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER env vars).
