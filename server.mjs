#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Resolve `claude` via PATH by default. Override with CLAUDE_CODE_PATH
// if the binary lives somewhere unusual.
const DEFAULT_CLAUDE_PATH = "claude";
const DEFAULT_TIMEOUT_MS = 120_000;
const SIGKILL_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB
const MAX_STDERR_BYTES = 65_536; // 64 KiB held in memory
const MAX_STDERR_RETURN_BYTES = 2_048; // 2 KiB returned to caller

// Explicit allowlist — any credential or secret in the parent env stays
// in the parent. Avoids leaking GITHUB_TOKEN, OPENAI_API_KEY, AWS creds,
// SUPABASE_SERVICE_ROLE_KEY, etc. to the child even with tools disabled.
const ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "LANG", "LC_ALL", "LC_CTYPE",
  "TMPDIR", "TEMP", "TMP",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "TERM", "COLORTERM", "NO_COLOR",
  "CLAUDE_CODE_PATH",
]);

// First char must be alphanumeric — blocks leading `-` so a model value
// can never be (mis)interpreted as another CLI flag in any downstream parser.
const MODEL_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

function buildChildEnv() {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

// Strip absolute paths and truncate so we don't return file locations,
// auth paths, or full stack traces to the caller.
function scrubStderr(raw) {
  if (!raw) return "";
  let out = raw;
  const home = os.homedir();
  const tmp = os.tmpdir();
  if (home) out = out.split(home).join("~");
  if (tmp) out = out.split(tmp).join("$TMPDIR");
  out = out.replace(/\/(Users|home)\/[^\s/"']+/g, "/$1/<redacted>");
  out = out.trim();
  if (out.length > MAX_STDERR_RETURN_BYTES) {
    out = `...[truncated ${out.length - MAX_STDERR_RETURN_BYTES} bytes]...\n` +
      out.slice(-MAX_STDERR_RETURN_BYTES);
  }
  return out;
}

const activeChildren = new Set();

function runClaudeCode({ prompt, model, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format", "text",
      "--input-format", "text",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--permission-mode", "dontAsk",
      "--tools", "",
    ];

    if (model) args.push("--model", model);

    const child = spawn(
      process.env.CLAUDE_CODE_PATH ?? DEFAULT_CLAUDE_PATH,
      args,
      { env: buildChildEnv(), stdio: ["pipe", "pipe", "pipe"] },
    );
    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let settled = false;

    function settle(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      fn();
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }, SIGKILL_GRACE_MS);
      settle(() => reject(new Error(`Claude Code timed out after ${timeoutMs} ms.`)));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        settle(() => reject(new Error("Claude Code stdout exceeded size limit.")));
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Cap stderr memory in-place; keep the tail since errors usually
      // surface near the end of the stream.
      if (stderr.length > MAX_STDERR_BYTES) {
        stderr = stderr.slice(-MAX_STDERR_BYTES);
      }
    });

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        settle(() => reject(new Error(
          "Could not find the `claude` binary on PATH. " +
          "Install Claude Code, or set CLAUDE_CODE_PATH to its absolute path.",
        )));
        return;
      }
      settle(() => reject(err));
    });

    child.on("close", (code) => {
      settle(() => {
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }
        const scrubbed = scrubStderr(stderr);
        reject(new Error(
          `Claude Code exited with code ${code}.${scrubbed ? `\n\nstderr:\n${scrubbed}` : ""}`,
        ));
      });
    });

    child.stdin.end(prompt);
  });
}

// If the parent (Codex/whatever spawned us) terminates, take any in-flight
// Claude children with us instead of leaving orphans behind.
function shutdown() {
  for (const child of activeChildren) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  setTimeout(() => {
    for (const child of activeChildren) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    process.exit(0);
  }, 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// -----------------------------------------------------------------------
// Structured review tool: wraps the prompt with strict JSON-output rules
// and validates the response server-side before returning to the caller.
// -----------------------------------------------------------------------

const REVIEW_PROMPT_HEADER = `You are reviewing the content below. Respond with EXACTLY ONE JSON object and nothing else — no prose, no markdown code fences, no commentary.

Required schema (every field is required):
{
  "verdict": "LGTM" | "CONCERNS" | "REJECT",
  "concerns": string[],
  "confidence": integer 1-10,
  "summary": string (max 500 chars)
}

Semantics:
- LGTM     — nothing worth raising
- CONCERNS — issues worth fixing, but not necessarily blocking
- REJECT   — should not proceed as-is

Confidence: 1 = guessing, 10 = certain.

Review request:
---
`;

const REVIEW_PROMPT_FOOTER = `
---
Respond now with only the JSON object.`;

const reviewSchema = z.object({
  verdict: z.enum(["LGTM", "CONCERNS", "REJECT"]),
  concerns: z.array(z.string().max(2_000)).max(100),
  confidence: z.number().int().min(1).max(10),
  summary: z.string().max(2_000),
});

function extractJsonObject(raw) {
  let s = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` wrappers if Claude added them.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("response did not contain a JSON object");
  }
  return s.slice(start, end + 1);
}

// -----------------------------------------------------------------------
// MCP server
// -----------------------------------------------------------------------

const server = new McpServer({
  name: "claude-code",
  version: "0.3.1",
});

server.registerTool(
  "ask_claude_code",
  {
    title: "Ask Claude Code",
    description:
      "Ask the locally authenticated Claude Code CLI for a second opinion. Returns Claude's response as plain text.",
    inputSchema: {
      prompt: z.string().min(1).max(100_000),
      model: z.string().regex(MODEL_REGEX).optional(),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
    },
  },
  async ({ prompt, model, timeout_ms }) => {
    const text = await runClaudeCode({
      prompt,
      model,
      timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
    });
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "ask_claude_code_review",
  {
    title: "Ask Claude Code for a structured review",
    description:
      "Get a structured review from Claude: { verdict: LGTM|CONCERNS|REJECT, concerns: string[], confidence: 1-10, summary: string }. Use this when you want to programmatically gate on Claude's opinion.",
    inputSchema: {
      prompt: z.string().min(1).max(100_000),
      model: z.string().regex(MODEL_REGEX).optional(),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
    },
  },
  async ({ prompt, model, timeout_ms }) => {
    const wrapped = REVIEW_PROMPT_HEADER + prompt + REVIEW_PROMPT_FOOTER;
    const raw = await runClaudeCode({
      prompt: wrapped,
      model,
      timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
    });

    let parsed;
    try {
      parsed = JSON.parse(extractJsonObject(raw));
    } catch (err) {
      const sample = raw.slice(0, 500);
      throw new Error(
        `Claude returned malformed JSON (${err.message}). First 500 chars of response:\n${sample}`,
      );
    }

    const result = reviewSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new Error(`Claude's JSON did not match the review schema: ${issues}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.data, null, 2),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
