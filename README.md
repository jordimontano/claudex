<h1 align="center">claudex</h1>

<p align="center">
  <i>Let Codex phone a friend.</i>
</p>

<p align="center">
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

- 🔑 **No API key.** Reuses your existing `claude auth` session.
- 🧰 **No tools in the subprocess.** Claude runs with `--tools ""` — pure text in, pure text out.
- 🔒 **No env leakage.** Strict allowlist — your `GITHUB_TOKEN`, `OPENAI_API_KEY`, AWS creds, etc. never touch the child process.
- ⏱ **No hangs.** Hard timeout, SIGTERM, then SIGKILL fallback.
- 🪶 **No bloat.** One file. Two dependencies.

## Install

```sh
git clone https://github.com/jordimontano/claudex.git
cd claudex
npm install
```

You also need [Claude Code](https://docs.claude.com/claude-code) installed and logged in — run `claude` once to authenticate.

## Wire it up to Codex

Add to your Codex MCP config (`~/.codex/config.toml`):

```toml
[mcp_servers.claudex]
command = "node"
args = ["/absolute/path/to/claudex/server.mjs"]
```

Restart Codex. The `ask_claude_code` tool will show up in its toolbox.

> **Tip:** any MCP-aware client works. Drop the same `command`/`args` into Claude Desktop, Cursor, Zed, or your own agent and it just runs.

## The tool

### `ask_claude_code`

Send a prompt to Claude Code and get plain-text output back.

| Param | Type | Required | Bounds |
|---|---|---|---|
| `prompt` | string | yes | 1 – 100,000 chars |
| `model` | string | no | matches `^[a-zA-Z0-9._:-]{1,64}$`, e.g. `claude-sonnet-4-6` |
| `timeout_ms` | number | no | 1,000 – 600,000. Default `120000` |

**Example usage from an MCP client:**

```json
{
  "tool": "ask_claude_code",
  "arguments": {
    "prompt": "Critique this SQL migration for safety under concurrent writes:\n\nALTER TABLE users ADD COLUMN ...",
    "model": "claude-opus-4-7"
  }
}
```

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
- Caps `stdout` at 1 MiB and `prompt` at 100 KB.
- Validates the `model` argument against a strict regex.
- Scrubs absolute paths from `stderr` before returning errors (no `/Users/<you>/…` in tracebacks).
- SIGTERM on timeout, SIGKILL 5 s later if the child won't quit.

If you spot a way to break any of the above, please [open an issue](https://github.com/jordimontano/claudex/issues) or message me.

## Development

```sh
node server.mjs    # runs the MCP server on stdio
node --check server.mjs   # syntax check
```

The whole thing is one ~140-line file ([`server.mjs`](server.mjs)). Read it. It's short.

## License

[MIT](LICENSE) © Jordi Montano
