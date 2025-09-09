// index.js — Render-ready realtime voice agent (Twilio -> Deepgram -> OpenAI -> Deepgram TTS -> Twilio)
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const OpenAI = require('openai');
const { createClient } = require('@deepgram/sdk');

const VoiceResponse = twilio.twiml.VoiceResponse;

const PORT = process.env.PORT || 10000;
const SERVER_BASE_URL = process.env.SERVER_BASE_URL; // e.g. https://your-app.onrender.com

if (!SERVER_BASE_URL) {
  console.error('Please set SERVER_BASE_URL in env (https URL of your Render service).');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Simple in-memory store per streamSid
const calls = new Map();

// Helper: sleep ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- TwiML endpoints ---------- */

// Start outbound call (for testing)
app.get('/start-call', async (req, res) => {
  try {
    const call = await twilioClient.calls.create({
      url: `${SERVER_BASE_URL}/handle-call`,
      to: process.env.YOUR_PHONE_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      statusCallback: `${SERVER_BASE_URL}/call-status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });
    res.send(`Call started. SID: ${call.sid}`);
  } catch (err) {
    console.error('start-call error', err);
    res.status(500).send(err.message || String(err));
  }
});

// Twilio will fetch this TwiML when call is answered (or configure as number webhook)
app.post('/handle-call', (req, res) => {
  const twiml = new VoiceResponse();

  // Use wss url explicitly (convert https -> wss)
  const wssUrl = SERVER_BASE_URL.replace(/^http/, 'wss') + '/media-stream';

  // Start a bidirectional stream
  twiml.start().stream({
    url: wssUrl,
    // Twilio supports "inbound_track" or "both_tracks". "both_tracks" includes outbound too.
    track: 'both_tracks'
  });

  // Greeting
  twiml.say({ voice: 'Polly.Joanna' }, "Hello — connecting you to the AI assistant. Please speak after the beep.");

  // Keep call alive (Twilio will hold stream open while websocket is connected, but pause helps)
  twiml.pause({ length: 60 });

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/call-status', (req, res) => {
  // Optional: use status updates for cleanup / logging
  console.log('Call status:', req.body.CallSid, req.body.CallStatus);
  res.sendStatus(200);
});

/* ---------- WebSocket upgrade ---------- */
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

/* ---------- Helpers ---------- */

async function bufferFromReadableStream(stream) {
  // Deepgram SDK stream has getReader()
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function queryOpenAI(history) {
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: history,
      max_tokens: 120,
      temperature: 0.2
    });
    return resp.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (e) {
    console.error('OpenAI error', e);
    return "Sorry, I'm having trouble responding right now.";
  }
}

/* ---------- WebSocket connection handling (Twilio media) ---------- */
wss.on('connection', (ws, req) => {
  console.log('🔗 Twilio connected to /media-stream');

  let streamSid = null;
  let callSid = null;
  let dgLive = null;

  // create Deepgram live once start message arrives; we create it lazily
  function createDeepgramLive() {
    if (dgLive) return;
    dgLive = deepgram.listen.live({
      model: 'nova-2',
      encoding: 'mulaw', // Twilio sends mulaw 8k
      sample_rate: 8000,
      interim_results: false // prefer final-only for replies
    });

    dgLive.addListener('open', () => console.log('✅ Deepgram live opened'));
    dgLive.addListener('error', (e) => console.error('Deepgram live error:', e));

    dgLive.addListener('transcriptReceived', async (dgMsg) => {
      try {
        // Some dgMsg structures include is_final flag; prefer final transcripts
        if (dgMsg.is_final === false) return; // wait for final
        const transcript = dgMsg?.channel?.alternatives?.[0]?.transcript?.trim();
        if (!transcript) return;

        console.log(`[${streamSid}] transcriptReceived:`, transcript);

        // Build short history to keep costs low
        let record = calls.get(streamSid) || { history: [] };
        const hist = record.history || [
          { role: 'system', content: 'You are a concise phone assistant. Keep replies short.' }
        ];
        hist.push({ role: 'user', content: transcript });

        // Query OpenAI
        const reply = await queryOpenAI(hist);
        hist.push({ role: 'assistant', content: reply });

        // Save history (cap size)
        record.history = (hist.length > 20) ? hist.slice(-20) : hist;
        calls.set(streamSid, record);

        console.log(`[${streamSid}] assistant reply:`, reply);

        // Generate TTS audio from Deepgram (μ-law 8k)
        const ttsResponse = await deepgram.speak.request(
          { text: reply },
          { model: 'aura-asteria-en', encoding: 'mulaw', sample_rate: 8000 }
        );
        const audioStream = await ttsResponse.getStream();
        const audioBuf = await bufferFromReadableStream(audioStream); // raw μ-law bytes

        // Send audio back to Twilio in small 20ms frames (160 bytes)
        const CHUNK_SIZE = 160; // 20ms * 8000samples/sec * 1 byte/sample (μ-law)
        for (let offset = 0; offset < audioBuf.length; offset += CHUNK_SIZE) {
          const chunk = audioBuf.slice(offset, offset + CHUNK_SIZE);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: chunk.toString('base64') }
            }));
            // pace — Twilio expects realtime pacing
            await sleep(20);
          } else {
            break;
          }
        }

        // send a mark to indicate playback end
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'tts_end' } }));
        }
      } catch (err) {
        console.error('Error in transcriptReceived handler:', err);
      }
    });
  }

  ws.on('message', async (raw) => {
    // Twilio sends JSON messages as strings
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.warn('Non-JSON message from Twilio', e);
      return;
    }

    // handle start event from Twilio: contains streamSid and callSid
    if (msg.event === 'start' || msg.event === 'connected' || msg.event === 'initiated') {
      streamSid = msg.start?.streamSid || msg.streamSid || msg.start?.stream_sid;
      callSid = msg.start?.callSid || msg.start?.call_sid || msg.callSid || null;
      console.log('Stream started:', streamSid, 'callSid:', callSid);
      calls.set(streamSid, { ws, callSid, history: [] });

      // create Deepgram live connection
      createDeepgramLive();
      return;
    }

    // media frames from Twilio (base64 μ-law)
    if (msg.event === 'media' && msg.media && msg.media.payload) {
      const b64 = msg.media.payload;
      const audioBuffer = Buffer.from(b64, 'base64');

      if (!dgLive) {
        // If Deepgram not created yet, create it (fallback)
        createDeepgramLive();
      }

      try {
        // forward raw audio bytes to Deepgram live
        dgLive.send(audioBuffer);
      } catch (e) {
        console.error('Error forwarding audio to Deepgram:', e);
      }
      return;
    }

    // stop event — cleanup
    if (msg.event === 'stop') {
      console.log('Stream stopped:', streamSid);
      if (dgLive && dgLive.finish) dgLive.finish();
      calls.delete(streamSid);
      return;
    }

    // ignore other events
  });

  ws.on('close', () => {
    console.log('WebSocket closed for stream', streamSid);
    if (dgLive && dgLive.finish) try { dgLive.finish(); } catch (e) {}
    if (streamSid) calls.delete(streamSid);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error', err);
  });
});

/* ---------- Start server ---------- */
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}. SERVER_BASE_URL=${SERVER_BASE_URL}`);
});
