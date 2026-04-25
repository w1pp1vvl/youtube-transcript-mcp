import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { YoutubeTranscript } from "youtube-transcript";
import express from "express";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

const transports = {};

const createServer = () => {
  const server = new McpServer({
    name: "youtube-transcript",
    version: "1.0.0",
  });

  server.tool(
    "get_transcript",
    "Extract transcript/subtitles from a YouTube video URL",
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

        const config = {};
        if (language) config.lang = language;

        const transcript = await YoutubeTranscript.fetchTranscript(videoId, config);

        if (!transcript || transcript.length === 0) {
          return { content: [{ type: "text", text: "No transcript available for this video" }] };
        }

        const text = transcript
          .map((entry) => {
            const mins = Math.floor(entry.offset / 60000);
            const secs = Math.floor((entry.offset % 60000) / 1000);
            const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
            return `[${ts}] ${entry.text}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Transcript for ${url} (${transcript.length} segments):\n\n${text}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching transcript: ${err.message}` }],
        };
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

// GET for SSE
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "No session" });
  }
});

// DELETE session
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (transports[sessionId]) {
    delete transports[sessionId];
  }
  res.status(200).json({ ok: true });
});

// Health check
app.get("/", (req, res) => {
  res.json({ name: "youtube-transcript-mcp", status: "ok", version: "1.0.0" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`YouTube Transcript MCP server running on port ${PORT}`);
});
