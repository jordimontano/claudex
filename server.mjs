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
const MAX_STDERR_RETURN_BYTES = 2_048; // 2 KiB

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
  // Catch any other /Users/<name> or /home/<name> paths.
  out = out.replace(/\/(Users|home)\/[^\s/"']+/g, "/$1/<redacted>");
  out = out.trim();
  if (out.length > MAX_STDERR_RETURN_BYTES) {
    out = `...[truncated ${out.length - MAX_STDERR_RETURN_BYTES} bytes]...\n` +
      out.slice(-MAX_STDERR_RETURN_BYTES);
  }
  return out;
}

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

    let stdout = "";
    let stderr = "";
    let settled = false;

    function settle(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
        settle(() => reject(new Error("Claude Code output exceeded size limit.")));
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      // Surface a friendlier message when the binary isn't on PATH.
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

const server = new McpServer({
  name: "claude-code",
  version: "0.2.0",
});

server.registerTool(
  "ask_claude_code",
  {
    title: "Ask Claude Code",
    description:
      "Ask the locally authenticated Claude Code CLI for a second opinion without using an Anthropic API key.",
    inputSchema: {
      prompt: z.string().min(1).max(100_000),
      model: z.string().regex(/^[a-zA-Z0-9._:-]{1,64}$/).optional(),
      timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
    },
  },
  async ({ prompt, model, timeout_ms }) => {
    const text = await runClaudeCode({
      prompt,
      model,
      timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
    });

    return {
      content: [{ type: "text", text }],
    };
  },
);

await server.connect(new StdioServerTransport());
