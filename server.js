import express from "express";
async function openaiChatReply(userText) {
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('Missing OPENAI_API_KEY');


const messages = [
{ role: 'system', content: 'You are a friendly avatar assistant. Reply concisely and in a voice suitable for speaking aloud. Keep replies short.' },
{ role: 'user', content: userText }
];


const res = await axios.post(
'https://api.openai.com/v1/chat/completions',
{ model: 'gpt-4o-mini', messages, max_tokens: 200 },
{ headers: { Authorization: `Bearer ${key}` }, timeout: 60000 }
);


const reply = res.data?.choices?.[0]?.message?.content?.trim() || '';
return reply;
}


// Utility: call HeyGen Interactive API (create streaming session / speak)
async function heygenCreateStream(text) {
const key = process.env.HEYGEN_API_KEY;
if (!key) throw new Error('Missing HEYGEN_API_KEY');


// Example payload - adapt fields to HeyGen's current API spec
const payload = {
avatar_id: process.env.HEYGEN_AVATAR_ID || 'thaddeus_chair_public',
voice: process.env.HEYGEN_VOICE || 'sophia',
text,
// request HLS stream
stream: true,
video: { width: 1280, height: 720 }
};


const res = await axios.post('https://api.heygen.com/v1/streaming.create', payload, {
headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
timeout: 60000
});


// Example response shape: { data: { stream_url: 'https://stream.heygen.com/hls/abcd/index.m3u8' } }
const streamUrl = res.data?.data?.stream_url || res.data?.stream_url || '';
return streamUrl;
}


// Endpoint: Recall.ai will POST raw audio here
app.post('/recall-audio', bodyParser.raw({ type: ['audio/*'], limit: '60mb' }), async (req, res) => {
try {
console.log('Received audio chunk, bytes=', req.body?.length);
const contentType = req.get('Content-Type') || 'audio/mpeg';


// 1) STT
const text = await elevenLabsSTT(req.body, contentType);
console.log('STT text:', text);
if (!text || !text.trim()) return res.status(200).json({ ok: true, text: '' });


// 2) ChatGPT
const reply = await openaiChatReply(text);
console.log('ChatGPT reply:', reply);


latestReply = reply;
latestMeta.time = new Date().toISOString();


// 3) Ask HeyGen to render this reply and return HLS stream URL
const streamUrl = await heygenCreateStream(reply);
console.log('HeyGen stream_url:', streamUrl);


if (streamUrl) latestStreamUrl = streamUrl;


return res.status(200).json({ ok: true, text, reply, stream_url: streamUrl });
} catch (err) {
console.error('/recall-audio error:', err?.message || err);
return res.status(500).json({ error: err?.message || String(err) });
}
});


app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
