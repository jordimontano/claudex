// Smoke test for claudex-mcp — speaks real MCP over stdio.
// Requires `claude` to be installed and logged in (the server spawns it).
// Run with: `npm test`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "..", "server.mjs");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? `  —  ${detail}` : ""}`);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER_PATH],
});

const client = new Client(
  { name: "claudex-smoke", version: "1.0.0" },
  { capabilities: {} },
);

await client.connect(transport);
record("connect", true, "MCP handshake completed");

// ---------- tools/list ----------
try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = ["ask_claude_code", "ask_claude_code_review"].sort();
  const ok = JSON.stringify(names) === JSON.stringify(expected);
  record("tools/list", ok, `got ${JSON.stringify(names)}`);
} catch (err) {
  record("tools/list", false, err.message);
}

async function expectRejection(label, args, toolName = "ask_claude_code") {
  try {
    const res = await client.callTool({ name: toolName, arguments: args });
    if (res?.isError) {
      const text = res.content?.[0]?.text ?? "";
      record(label, true, `isError: ${text.slice(0, 80)}`);
      return;
    }
    record(label, false, `expected error, got: ${JSON.stringify(res).slice(0, 120)}`);
  } catch (err) {
    record(label, true, `threw: ${err.message.slice(0, 80)}`);
  }
}

await expectRejection("rejects model with leading hyphen", { prompt: "hi", model: "--rce" });
await expectRejection("rejects empty prompt", { prompt: "" });
await expectRejection("rejects prompt > 100k chars", { prompt: "x".repeat(100_001) });

// ---------- live: ask_claude_code ----------
try {
  const start = Date.now();
  const res = await client.callTool({
    name: "ask_claude_code",
    arguments: {
      prompt:
        "Reply with exactly the single word: pong. No punctuation, no quotes, no other words.",
      timeout_ms: 60_000,
    },
  });
  const text = (res.content?.[0]?.text ?? "").trim().toLowerCase();
  const ok = text === "pong" || text.startsWith("pong");
  record(
    "ask_claude_code returns text",
    ok,
    `${Date.now() - start}ms, got "${text.slice(0, 60)}"`,
  );
} catch (err) {
  record("ask_claude_code returns text", false, err.message);
}

// ---------- live: ask_claude_code_review structured output ----------
try {
  const start = Date.now();
  const res = await client.callTool({
    name: "ask_claude_code_review",
    arguments: {
      prompt:
        "Review this trivial function for issues:\n\n" +
        "```js\nfunction add(a, b) { return a + b; }\n```",
      timeout_ms: 60_000,
    },
  });
  const text = res.content?.[0]?.text ?? "";
  const parsed = JSON.parse(text);
  const hasFields =
    typeof parsed.verdict === "string" &&
    Array.isArray(parsed.concerns) &&
    typeof parsed.confidence === "number" &&
    typeof parsed.summary === "string";
  const verdictOk = ["LGTM", "CONCERNS", "REJECT"].includes(parsed.verdict);
  const confidenceOk =
    Number.isInteger(parsed.confidence) &&
    parsed.confidence >= 1 &&
    parsed.confidence <= 10;
  const ok = hasFields && verdictOk && confidenceOk;
  record(
    "ask_claude_code_review returns valid schema",
    ok,
    `${Date.now() - start}ms, verdict=${parsed.verdict} confidence=${parsed.confidence}`,
  );
} catch (err) {
  record("ask_claude_code_review returns valid schema", false, err.message);
}

await client.close();

const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`,
);
process.exit(failed ? 1 : 0);
