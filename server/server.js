import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 8080;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const BUILD_RUNNER_URL = (process.env.BUILD_RUNNER_URL || "").replace(/\/$/, "");
const BUILD_RUNNER_SECRET = process.env.BUILD_RUNNER_SECRET || "";
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const SYSTEM = `You are the AI engine for a Flutter app builder.
Return ONLY valid JSON with this shape:
{"message":"short explanation","files":[{"path":"lib/main.dart","content":"..."}]}
Generate coherent Flutter source files. Keep imports and dependencies consistent.
When adding packages, include/update pubspec.yaml. Never claim the app compiled.
Do not include markdown fences. Prefer a small complete starter project unless the user asks for more.
`;

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    groqConfigured: Boolean(GROQ_API_KEY),
    buildRunnerConfigured: Boolean(BUILD_RUNNER_URL && BUILD_RUNNER_SECRET),
    model: MODEL
  })
);

app.post("/api/generate", async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(503).json({ error: "GROQ_API_KEY is not configured on the server." });
  }
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "prompt is required" });
  const existing = Array.isArray(req.body?.files) ? req.body.files.slice(0, 30) : [];
  const user = `Build or modify this Flutter application:
${prompt}

Existing project files:
${JSON.stringify(existing)}
Return the complete files needed for the requested result.`;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Groq request failed" });
    const raw = data?.choices?.[0]?.message?.content || "{}";
    let result;
    try { result = JSON.parse(raw); } catch { return res.status(502).json({ error: "Groq returned invalid JSON" }); }
    if (!Array.isArray(result.files)) result.files = [];
    res.json({
      message: result.message || "Project generated.",
      files: result.files.filter(f => f && typeof f.path === "string" && typeof f.content === "string")
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Generation failed" });
  }
});

function runnerHeaders() {
  return { Authorization: `Bearer ${BUILD_RUNNER_SECRET}`, "Content-Type": "application/json" };
}

app.post("/api/build", async (req, res) => {
  if (!BUILD_RUNNER_URL || !BUILD_RUNNER_SECRET) {
    return res.status(503).json({ error: "Flutter build runner is not configured." });
  }
  const format = req.body?.format === "aab" ? "aab" : "apk";
  const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 100) : [];
  if (!files.length) return res.status(400).json({ error: "project files are required" });
  try {
    const r = await fetch(`${BUILD_RUNNER_URL}/builds`, {
      method: "POST",
      headers: runnerHeaders(),
      body: JSON.stringify({ format, files, projectName: String(req.body?.projectName || "Flutter project") })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error || "Build runner request failed" });
    res.status(202).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message || "Unable to reach build runner" });
  }
});

app.get("/api/build/:id", async (req, res) => {
  if (!BUILD_RUNNER_URL || !BUILD_RUNNER_SECRET) {
    return res.status(503).json({ error: "Flutter build runner is not configured." });
  }
  try {
    const r = await fetch(`${BUILD_RUNNER_URL}/builds/${encodeURIComponent(req.params.id)}`, {
      headers: { Authorization: `Bearer ${BUILD_RUNNER_SECRET}` }
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error || "Build status request failed" });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message || "Unable to reach build runner" });
  }
});

const distDir = path.join(rootDir, "dist");
app.use(express.static(distDir));

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path === "/health") {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(PORT, () => console.log(`AI Builder listening on ${PORT}`));