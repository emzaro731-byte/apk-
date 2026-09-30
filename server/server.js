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

const SYSTEM = `You are the conversational AI product designer and Flutter code generator for an AI app builder.
Behave like ChatGPT: do NOT immediately build an app from a vague request. First understand what the user wants by asking only 1 or 2 useful questions total. Keep the questioning short and do not make the user go through a long questionnaire.
Return ONLY valid JSON with this shape:
{"mode":"questions"|"generated","message":"short natural reply","questions":["question 1","question 2"],"files":[{"path":"lib/main.dart","content":"..."}]}
Use mode "questions" when important product decisions are still unknown. Ask only 1 or 2 questions in one short round, prioritizing the two decisions that matter most to the requested app. Never ask more than 2 questions. Combine related details into one question when possible, and choose sensible defaults for everything else. After the user answers those questions, use mode "generated" rather than asking another round unless the request is genuinely impossible to complete without clarification.
Use mode "generated" when you have enough information. Then generate a coherent Flutter project and include all required source files. Keep imports and dependencies consistent. When adding packages, include/update pubspec.yaml.
Never claim the app compiled or is production-ready unless a real build result is supplied.
Do not include markdown fences.
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
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[generate:${requestId}] request received`);

  if (!GROQ_API_KEY) {
    console.error(`[generate:${requestId}] GROQ_API_KEY is missing`);
    return res.status(503).json({
      error: "AI backend configuration error: GROQ_API_KEY is not configured on the Render server.",
      code: "MISSING_GROQ_API_KEY",
      requestId
    });
  }

  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) {
    console.error(`[generate:${requestId}] prompt is missing`);
    return res.status(400).json({ error: "Prompt is empty. Describe the app you want to build.", code: "EMPTY_PROMPT", requestId });
  }

  const existing = Array.isArray(req.body?.files) ? req.body.files.slice(0, 30) : [];
  const conversation = Array.isArray(req.body?.conversation) ? req.body.conversation.slice(-20) : [];
  const user = `Help the user design and build this Flutter application:
${prompt}

Conversation so far:
${JSON.stringify(conversation)}

Existing project files:
${JSON.stringify(existing)}

If important product requirements are missing, ask concise questions instead of generating code. If enough information is available, generate the complete files needed for the result.`;

  try {
    console.log(`[generate:${requestId}] calling Groq model=${MODEL}`);
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

    const rawBody = await r.text();
    let data = {};
    try { data = rawBody ? JSON.parse(rawBody) : {}; } catch {
      console.error(`[generate:${requestId}] Groq returned non-JSON HTTP ${r.status}: ${rawBody.slice(0, 500)}`);
      return res.status(502).json({
        error: `Groq returned an invalid response (HTTP ${r.status}). Check the Render logs for request ${requestId}.`,
        code: "GROQ_INVALID_RESPONSE",
        requestId
      });
    }

    if (!r.ok) {
      const providerMessage = data?.error?.message || `Groq returned HTTP ${r.status}`;
      console.error(`[generate:${requestId}] Groq error HTTP ${r.status}: ${providerMessage}`);
      return res.status(r.status).json({
        error: `AI provider error: ${providerMessage}`,
        code: "GROQ_API_ERROR",
        providerStatus: r.status,
        requestId
      });
    }

    const raw = data?.choices?.[0]?.message?.content || "{}";
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      console.error(`[generate:${requestId}] Groq returned invalid JSON content`);
      return res.status(502).json({
        error: "AI provider returned text that was not valid JSON. Try again; if it continues, check the Render logs.",
        code: "GROQ_INVALID_JSON",
        requestId
      });
    }

    if (!Array.isArray(result.files)) result.files = [];
    console.log(`[generate:${requestId}] success mode=${result.mode === "questions" ? "questions" : "generated"} files=${result.files.length}`);

    res.json({
      mode: result.mode === "questions" ? "questions" : "generated",
      message: result.message || (result.mode === "questions" ? "I have a few questions before I build it." : "Project generated."),
      questions: Array.isArray(result.questions) ? result.questions.filter(q => typeof q === "string").slice(0, 2) : [],
      files: result.files.filter(f => f && typeof f.path === "string" && typeof f.content === "string"),
      requestId
    });
  } catch (e) {
    console.error(`[generate:${requestId}] server/network error:`, e);
    return res.status(502).json({
      error: `AI connection failed: ${e?.message || "Unable to reach Groq from the Render server."}`,
      code: "AI_CONNECTION_ERROR",
      requestId
    });
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

app.get("/api/build/:id/artifact", async (req, res) => {
  if (!BUILD_RUNNER_URL || !BUILD_RUNNER_SECRET) {
    return res.status(503).json({ error: "Flutter build runner is not configured." });
  }
  try {
    const r = await fetch(`${BUILD_RUNNER_URL}/builds/${encodeURIComponent(req.params.id)}/artifact`, {
      headers: { Authorization: `Bearer ${BUILD_RUNNER_SECRET}` }
    });
    if (!r.ok) {
      let message = "Artifact download failed";
      try { const data = await r.json(); message = data?.error || message; } catch {}
      return res.status(r.status).json({ error: message });
    }
    const type = r.headers.get("content-type") || "application/octet-stream";
    const disposition = r.headers.get("content-disposition");
    res.status(r.status);
    res.setHeader("Content-Type", type);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (r.body) {
      for await (const chunk of r.body) res.write(chunk);
      return res.end();
    }
    return res.status(502).json({ error: "Runner returned an empty artifact" });
  } catch (e) {
    res.status(502).json({ error: e.message || "Unable to download artifact" });
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