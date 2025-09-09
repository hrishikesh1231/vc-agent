require("dotenv").config();
const express = require("express");
const http = require("http");
const twilio = require("twilio");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk");
const OpenAI = require("openai");
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.urlencoded({ extended: true }));

// Clients
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Conversation memory
const conversationHistories = new Map();

// ✅ Start the call
app.get("/start-call", async (req, res) => {
    try {
        const call = await twilioClient.calls.create({
            url: `${process.env.SERVER_BASE_URL}/handle-call`,
            to: process.env.YOUR_PHONE_NUMBER,
            from: process.env.TWILIO_PHONE_NUMBER,
            statusCallback: `${process.env.SERVER_BASE_URL}/call-status`,
            statusCallbackMethod: "POST",
            statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
        });
        res.send(`✅ Call started! SID: ${call.sid}`);
    } catch (err) {
        console.error("❌ Error starting call:", err);
        res.status(500).send(err.message);
    }
});

// ✅ Handle Twilio call
app.post("/handle-call", (req, res) => {
    const twiml = new VoiceResponse();

    // Start streaming audio to our WebSocket
    twiml.start().stream({
        url: `${process.env.SERVER_BASE_URL.replace(/^http/, 'wss')}/media-stream`,
        track: "inbound_track"
    });

    // Greeting message
    twiml.say({ voice: "Polly.Joanna" }, "Hello Hrishi! I'm your AI assistant. How are you today?");
    twiml.pause({ length: 60 }); // keep the call alive

    res.type("text/xml");
    res.send(twiml.toString());
});

// ✅ Call status webhook
app.post("/call-status", (req, res) => {
    const callSid = req.body.CallSid;
    conversationHistories.delete(callSid);
    res.sendStatus(200);
});

// ✅ WebSocket upgrade
server.on("upgrade", (req, socket, head) => {
    if (req.url === "/media-stream") {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    } else {
        socket.destroy();
    }
});

// ✅ WebSocket connection handler
wss.on("connection", async (ws, req) => {
    console.log("🔗 Twilio connected to media stream");

    const dgLive = deepgram.listen.live({
        model: "nova-2",
        encoding: "mulaw",
        sample_rate: 8000,
        interim_results: true
    });

    dgLive.addListener("open", () => console.log("✅ Connected to Deepgram"));

    dgLive.addListener("transcriptReceived", async (dgMsg) => {
        const transcript = dgMsg.channel.alternatives[0].transcript;

        if (transcript && transcript.trim() !== "") {
            console.log(`👤 User: ${transcript}`);

            const reply = await getAgentResponse(transcript, "call-1");
            console.log(`🤖 Agent: ${reply}`);

            // Generate speech
            const audioBuffer = await generateSpeech(reply);

            // Send back to Twilio
            ws.send(JSON.stringify({
                event: "media",
                media: { payload: audioBuffer.toString("base64") }
            }));
        }
    });

    ws.on("message", (msg) => {
        const data = JSON.parse(msg);
        if (data.event === "media" && data.media?.payload) {
            dgLive.send(data.media.payload);
        }
    });

    ws.on("close", () => {
        console.log("❌ WebSocket closed, stopping Deepgram");
        dgLive.finish();
    });
});

// ✅ GPT response generator
async function getAgentResponse(userText, callSid) {
    let history = conversationHistories.get(callSid) || [
        { role: "system", content: "You are a friendly AI voice agent. Keep responses short and natural." }
    ];

    history.push({ role: "user", content: userText });

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: history
    });

    const reply = completion.choices[0].message.content;
    history.push({ role: "assistant", content: reply });
    conversationHistories.set(callSid, history);

    return reply;
}

// ✅ Generate speech (Deepgram TTS)
async function generateSpeech(text) {
    const response = await deepgram.speak.request(
        { text },
        { model: "aura-asteria-en", encoding: "linear16", sample_rate: 8000 }
    );

    const stream = await response.getStream();
    const chunks = [];
    const reader = stream.getReader();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }

    return Buffer.concat(chunks);
}

server.listen(process.env.PORT, () => {
    console.log(`🚀 Server running on ${process.env.SERVER_BASE_URL}`);
});
