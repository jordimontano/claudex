<h1 align="center">claudex</h1>

<p align="center">
  <i>Let Codex phone a friend.</i>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/claudex-mcp"><img src="https://img.shields.io/npm/v/claudex-mcp?color=black&label=npm" alt="npm version"></a>
  <a href="https://github.com/jordimontano/claudex/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-black.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-black.svg" alt="Node ≥ 18">
  <img src="https://img.shields.io/badge/MCP-server-black.svg" alt="MCP server">
  <img src="https://img.shields.io/badge/api%20key-not%20required-black.svg" alt="No API key required">
</p>

---

**claudex** is a tiny MCP server that exposes the locally-authenticated **Claude Code** CLI as a tool. Drop it into **Codex** (or any MCP client) and it can ask Claude for a second opinion — without an Anthropic API key, without an extra subscription, just your existing `claude` login.

```
   ┌─────────┐   ask_claude_code   ┌──────────┐    spawn     ┌─────────────┐
   │  Codex  │ ──────────────────▶ │ claudex  │ ───────────▶ │ claude CLI  │
   └─────────┘   text response     └──────────┘   text out   └─────────────┘
                                                                    │
                                                            your local auth
```

## Why you might want this

- **No API key.** Reuses your existing `claude auth` session.
- **No tools in the subprocess.** Claude runs with `--tools ""` — pure text in, pure text out.
- **No env leakage.** Strict allowlist — your `GITHUB_TOKEN`, `OPENAI_API_KEY`, AWS creds, etc. never touch the child process.
- **No hangs.** Hard timeout, SIGTERM, then SIGKILL fallback.
- **No bloat.** One file. Two dependencies.

## Install

You need [Claude Code](https://docs.claude.com/claude-code) installed and logged in. Run `claude` once to authenticate. That's the only prerequisite.

claudex itself doesn't need to be installed at all — `npx` will fetch and run it on demand. Just point Codex at it.

## Wire it up to Codex

Add to your Codex MCP config (`~/.codex/config.toml`):

```toml
[mcp_servers.claudex]
command = "npx"
args = ["-y", "claudex-mcp"]
```

Restart Codex. The `ask_claude_code` tool will show up in its toolbox.

> **Tip:** any MCP-aware client works. Drop the same `command`/`args` into Claude Desktop, Cursor, Zed, or your own agent and it just runs.

### Prefer a local clone?

```sh
git clone https://github.com/jordimontano/claudex.git
cd claudex
npm install
# then point Codex at `node /absolute/path/to/claudex/server.mjs`
```

## The tools

claudex exposes two tools. Use the first for free-form conversation, the second when you want a machine-readable answer.

### `ask_claude_code`

Send a prompt to Claude Code and get plain-text output back.

| Param | Type | Required | Bounds |
|---|---|---|---|
| `prompt` | string | yes | 1 – 100,000 chars |
| `model` | string | no | matches `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$`, e.g. `claude-sonnet-4-6` |
| `timeout_ms` | number | no | 1,000 – 600,000. Default `120000` |

**Example call:**

```json
{
  "tool": "ask_claude_code",
  "arguments": {
    "prompt": "Critique this SQL migration for safety under concurrent writes:\n\nALTER TABLE users ADD COLUMN ...",
    "model": "claude-opus-4-7"
  }
}
```

### `ask_claude_code_review`

Get a **structured JSON review** so the calling agent can branch on it programmatically.

Same parameters as `ask_claude_code`. claudex wraps your prompt with strict JSON-output instructions, parses Claude's response, and validates it against the schema below before returning. Malformed responses produce a clear error instead of silently breaking your caller.

**Response schema:**

```ts
{
  verdict:    "LGTM" | "CONCERNS" | "REJECT",
  concerns:   string[],
  confidence: 1 | 2 | ... | 10,
  summary:    string
}
```

**Example call:**

```json
{
  "tool": "ask_claude_code_review",
  "arguments": {
    "prompt": "Review this diff for race conditions:\n\ndiff --git a/...",
    "model": "claude-opus-4-7"
  }
}
```

**Example response:**

```json
{
  "verdict": "CONCERNS",
  "concerns": [
    "writes to `users.balance` are not wrapped in a transaction",
    "the retry loop has no backoff and can pile up on lock contention"
  ],
  "confidence": 8,
  "summary": "Logic is sound but the concurrency story needs work before this lands."
}
```

The calling agent can then do:

```js
if (review.verdict === "REJECT") abort();
if (review.verdict === "CONCERNS" && review.confidence >= 7) showHumanReview();
```

### Choosing a model

| Model | Best for | Speed |
|---|---|---|
| `claude-haiku-4-5` | Quick sanity checks, simple style/syntax review | Fast |
| `claude-sonnet-4-6` | Architecture review, refactor critique, general second opinion | Balanced |
| `claude-opus-4-7` | Security review, gnarly concurrency, anything where being right matters | Slower |

Omit the `model` parameter to let Claude Code pick its default.

## Configuration

| Env var | Purpose |
|---|---|
| `CLAUDE_CODE_PATH` | Absolute path to the `claude` binary if it isn't on `PATH`. |

## Security model

claudex is designed to make Claude useful as a sub-agent **without** dragging your secrets along for the ride.

**In the spawned `claude` subprocess:**

- `--tools ""` — no tool access (no Bash, no file I/O, nothing).
- `--permission-mode dontAsk` — no permission prompts can surface.
- `--no-session-persistence` — nothing is saved between calls.
- `--disable-slash-commands` — no `/` commands available.

**In claudex itself:**

- Forwards only an explicit allowlist of env vars (`PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR`, …). Everything else stays in the parent.
- Caps `stdout` at 1 MiB, `stderr` at 64 KiB in-memory, and `prompt` at 100 KB.
- Validates the `model` argument against a strict regex; the first character must be alphanumeric, so it can't ever be confused with a CLI flag.
- Scrubs absolute paths from `stderr` before returning errors (no `/Users/<you>/…` in tracebacks).
- SIGTERM on timeout, SIGKILL 5 s later if the child won't quit.
- Cleans up in-flight Claude subprocesses if the parent (Codex, etc.) terminates the MCP server — no orphan processes.

### Known limitations

- **`ask_claude_code_review` is not prompt-injection-proof.** The tool wraps your prompt with strict JSON-output instructions, but if you feed it untrusted text (e.g. content scraped from the web, a third-party PR description) that text could include adversarial instructions designed to manipulate Claude's verdict. This is the universal "wrapping an LLM" problem. Treat reviews on untrusted input as advisory, not authoritative.
- **No concurrency cap.** A client that sends many tool calls in parallel will spawn that many `claude` subprocesses. In practice MCP clients call serially; if you need a hard cap, run claudex behind a semaphore.
- **The subprocess uses your local Claude subscription.** All standard Anthropic usage policies apply to whatever it generates.

If you spot a way to break any of the above, please [open an issue](https://github.com/jordimontano/claudex/issues) or message me.

## Development

```sh
npm start         # run the MCP server on stdio
npm run check     # syntax check
npm test          # smoke test against a live `claude` process (7 checks)
```

The whole thing is one short file: [`server.mjs`](server.mjs). The test harness ([`test/smoke.mjs`](test/smoke.mjs)) speaks real MCP over stdio and exercises both tools end-to-end.

## License

[MIT](LICENSE) © Jordi Montano
