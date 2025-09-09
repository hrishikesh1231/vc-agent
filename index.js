require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");
const twilio = require("twilio");
const OpenAI = require("openai");
const { createClient } = require("@deepgram/sdk");
const VoiceResponse = twilio.twiml.VoiceResponse;

// Clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// Memory for conversations
const conversationHistories = new Map();

// Start call
app.get("/start-call", async (req, res) => {
    try {
        const call = await twilioClient.calls.create({
            url: `${process.env.SERVER_BASE_URL}/handle-call`,
            to: process.env.YOUR_PHONE_NUMBER,
            from: process.env.TWILIO_PHONE_NUMBER,
            statusCallback: `${process.env.SERVER_BASE_URL}/call-status`,
            statusCallbackMethod: "POST",
            statusCallbackEvent: ["completed", "failed", "no-answer"]
        });
        res.send(`✅ Call started! SID: ${call.sid}`);
    } catch (err) {
        console.error("❌ Error starting call:", err);
        res.status(500).send(err.message);
    }
});

// Handle Twilio call
app.post("/handle-call", (req, res) => {
    const twiml = new VoiceResponse();
    twiml.start().stream({
        url: `${process.env.SERVER_BASE_URL}/media-stream`,
        track: "inbound_track"
    });
    twiml.say({ voice: "Polly.Joanna" }, "Hello Hrishi! I'm your AI assistant. Let's talk!");
    res.type("text/xml");
    res.send(twiml.toString());
});

// Call status
app.post("/call-status", (req, res) => {
    const callSid = req.body.CallSid;
    conversationHistories.delete(callSid);
    res.sendStatus(200);
});

// WebSocket Upgrade
server.on("upgrade", (req, socket, head) => {
    if (req.url === "/media-stream") {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    } else {
        socket.destroy();
    }
});

// WebSocket connection handler
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
            const audioUrl = await generateSpeech(reply);

            ws.send(JSON.stringify({ event: "media", media: { payload: audioUrl } }));
            console.log(`🤖 Agent: ${reply}`);
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

// GPT response
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

// Deepgram TTS
async function generateSpeech(text) {
    const response = await deepgram.speak.request(
        { text },
        { model: "aura-asteria-en", encoding: "mp3" }
    );

    const stream = await response.getStream();
    const buffer = await getAudioBuffer(stream);

    const fileName = `response_${Date.now()}.mp3`;
    const publicDir = path.join(__dirname, "public");
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

    const speechFile = path.join(publicDir, fileName);
    await fs.promises.writeFile(speechFile, buffer);

    return `${process.env.SERVER_BASE_URL}/${fileName}`;
}

async function getAudioBuffer(response) {
    const reader = response.getReader();
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

server.listen(process.env.PORT, () => {
    console.log(`🚀 Server running on port ${process.env.PORT}`);
});
