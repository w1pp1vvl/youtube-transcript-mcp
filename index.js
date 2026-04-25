import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { YoutubeTranscript } from "youtube-transcript";
import express from "express";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json());

const transports = {};

// --- Audio transcription via Deepgram ---
async function transcribeWithDeepgram(audioPath, lang) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY not set");

  const audioData = await fs.readFile(audioPath);
  const params = new URLSearchParams({
    model: "nova-3",
    language: lang || "ru",
    punctuate: "true",
    paragraphs: "true",
    utterances: "true",
  });

  const resp = await fetch(
    `https://api.deepgram.com/v1/listen?${params}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/mp3",
      },
      body: audioData,
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Deepgram API error ${resp.status}: ${text}`);
  }

  return await resp.json();
}

// --- Download audio via yt-dlp ---
async function downloadAudio(videoId) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-"));
  const outputPath = path.join(tmpDir, `${videoId}.mp3`);

  try {
    await execFileAsync(
      "yt-dlp",
      [
        "--no-check-certificates",
        "--js-runtimes", "node",
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "5",
        "-o", outputPath,
        "--no-playlist",
        "--max-filesize", "50m",
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: 120000 }
    );
    return outputPath;
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`yt-dlp failed: ${err.message}`);
  }
}

// --- Format Deepgram response to timestamped text ---
function formatDeepgramTranscript(dgResponse) {
  const segments = [];
  const utterances = dgResponse.results?.utterances;

  if (utterances && utterances.length > 0) {
    for (const u of utterances) {
      const mins = Math.floor(u.start / 60);
      const secs = Math.floor(u.start % 60);
      const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
      segments.push({ ts, text: u.transcript });
    }
  } else {
    const alt = dgResponse.results?.channels?.[0]?.alternatives?.[0];
    if (alt?.paragraphs?.paragraphs) {
      for (const p of alt.paragraphs.paragraphs) {
        for (const s of p.sentences) {
          const mins = Math.floor(s.start / 60);
          const secs = Math.floor(s.start % 60);
          const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
          segments.push({ ts, text: s.text });
        }
      }
    } else if (alt?.transcript) {
      segments.push({ ts: "00:00", text: alt.transcript });
    }
  }

  return segments;
}

// --- Core transcript function with fallback ---
async function getTranscript(videoId, lang) {
  // Try subtitles first
  try {
    const config = {};
    if (lang) config.lang = lang;
    const transcript = await YoutubeTranscript.fetchTranscript(videoId, config);

    if (transcript && transcript.length > 0) {
      const text = transcript
        .map((entry) => {
          const mins = Math.floor(entry.offset / 60000);
          const secs = Math.floor((entry.offset % 60000) / 1000);
          const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
          return `[${ts}] ${entry.text}`;
        })
        .join("\n");

      return { source: "subtitles", segments: transcript.length, text };
    }
  } catch (err) {
    console.log(`Subtitles not available for ${videoId}: ${err.message}`);
  }

  // Fallback: download audio + Deepgram
  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error("Subtitles disabled and DEEPGRAM_API_KEY not set for audio fallback");
  }

  console.log(`Downloading audio for ${videoId}...`);
  const audioPath = await downloadAudio(videoId);

  try {
    console.log(`Transcribing ${videoId} via Deepgram...`);
    const dgResult = await transcribeWithDeepgram(audioPath, lang);
    const segments = formatDeepgramTranscript(dgResult);

    if (segments.length === 0) {
      throw new Error("Deepgram returned empty transcript");
    }

    const text = segments.map((s) => `[${s.ts}] ${s.text}`).join("\n");
    return { source: "deepgram", segments: segments.length, text };
  } finally {
    const dir = path.dirname(audioPath);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- MCP Tool ---
const createServer = () => {
  const server = new McpServer({
    name: "youtube-transcript",
    version: "2.0.0",
  });

  server.tool(
    "get_transcript",
    "Extract transcript from a YouTube video. Falls back to audio speech-to-text via Deepgram if subtitles are disabled.",
    {
      url: { type: "string", description: "YouTube video URL (any format)" },
      language: { type: "string", description: "Language code (e.g. 'ru', 'en'). Optional." },
    },
    async ({ url, language }) => {
      try {
        const videoId = extractVideoId(url);
        if (!videoId) {
          return { content: [{ type: "text", text: "Error: Could not extract video ID from URL" }] };
        }

        const result = await getTranscript(videoId, language);
        return {
          content: [{
            type: "text",
            text: `Transcript for ${url} (${result.segments} segments, source: ${result.source}):\n\n${result.text}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
};

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// MCP endpoint
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] || randomUUID();
  let transport = transports[sessionId];
  if (!transport) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
    transports[sessionId] = transport;
    const server = createServer();
    await server.connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "No session" });
  }
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (transports[sessionId]) delete transports[sessionId];
  res.status(200).json({ ok: true });
});

// Health check
app.get("/", (req, res) => {
  res.json({
    name: "youtube-transcript-mcp",
    status: "ok",
    version: "2.0.0",
    deepgram: !!process.env.DEEPGRAM_API_KEY,
  });
});

// REST API endpoint
app.get("/transcript/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params;
    const lang = req.query.lang || undefined;
    const result = await getTranscript(videoId, lang);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`YouTube Transcript MCP v2.0 running on port ${PORT}`);
  console.log(`Deepgram fallback: ${process.env.DEEPGRAM_API_KEY ? "enabled" : "disabled"}`);
});
