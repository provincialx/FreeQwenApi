# FreeQwenApi — Local OpenAI-Compatible API via Qwen Chat

![Contact](https://img.shields.io/badge/Contact-mandrykinsergey@-blue)
![API](https://img.shields.io/badge/API-OpenAI--compatible-green)
![Qwen](https://img.shields.io/badge/Qwen-Chat-purple)

> **Turns [Zed.dev](https://zed.dev/) into a full AI agent** using your Qwen Chat web account.
> Contact: `mandrykinsergey@gmail.com` | [twitch.tv/dnovitv](https://www.twitch.tv/dnovitv)

## What is this?

Zed.dev is one of the fastest code editors available. It has a built-in AI agent that can read files, run terminal commands, and write code based on your prompts. But **Zed doesn't include a model** — it just talks to an OpenAI-compatible API.

FreeQwenApi bridges Zed and the Qwen Chat web app (`chat.qwen.ai`). It launches a headless browser, authenticates with your Qwen account, and serves model responses at `http://localhost:3264/api` in standard OpenAI format.

**Result:** Zed Agent gets full access to Qwen's powerful models — it can read your codebase, edit files, and run terminal commands as a fully autonomous agent. All for free (using a basic Qwen Chat account).

**This is not a locally downloaded model** and **not an official Alibaba API**. It's a browser-based proxy.

**Why this fork?** Most forks only return plain text. This one adds full `tool calling` — the model can invoke external tools (`read_file`, `write_file`, `terminal`) and operate in an automatic agent-loop cycle. That's the key advantage over other projects.

```text
Zed Agent    →  FreeQwenApi (localhost:3264)  →  Headless Browser (Puppeteer)  →  chat.qwen.ai
         ↑_________________________________________________________↓___________________________↓
                              Response + tool calls (OpenAI format)
```

## Getting Started

Requires [Node.js](https://nodejs.org/) version 18+.

### 1. Install and first run
```bash
git clone https://github.com/provincialx/FreeQwenApi
cd FreeQwenApi
npm install
```

### 2. Add a Qwen account
This opens a Chromium browser window. Log in to your account at `chat.qwen.ai`, then close the browser. Tokens are saved automatically to the `session/` folder.
```bash
npm run auth -- --add
```

### 3. Sync models and start the server
```bash
npm run models:sync         # fetches the latest list of available models (qwen3-coder-plus, qwen3-max...)
SKIP_ACCOUNT_MENU=true npm start
```

### 4. Verify it works
The server is ready on port `3264`. Run the built-in health check:
```bash
npm run smoke
```

## Connecting to Zed.dev

1. Install [Zed](https://zed.dev/).
2. Open settings: `Cmd+Shift+,` → **AI** tab.
3. Set **Base URL** to: `http://localhost:3264/api`
4. Set **API Key** to anything (e.g., `dummy-key`) — the server doesn't validate it
5. Set **Model** to your preferred option (`qwen3-coder-plus` or `qwen3.7-max` recommended)
6. Save. Zed Agent is now ready to use.

=====================================================================

> **⚠️ Important:** In your chat.qwen.ai profile → Personalization — disable all toggles, set style to "Concise", and clear any saved memory.

=====================================================================

**Test:** Press `Cmd+L` to open the AI panel and ask any question about your code.

## Tool Calling

Zed Agent can invoke external tools using the standard OpenAI tool calling protocol: reading files, writing code, running terminal commands. The model decides which tools to call, invokes them through Zed, receives results, and continues working — all automatically (agent loop).

**The challenge:** Qwen Chat's web API **does not accept tools** in standard OpenAI format (`"Tool X does not exists"`). FreeQwenApi works around this without quality loss:
1. Tool schemas are injected into the user message as text instructions (prompt injection).
2. Qwen generates tool calls as a JSON block within its normal text response.
3. The proxy parses this block, strips extraneous text, and returns clean `tool_calls` to Zed Agent in OpenAI format.

Works reliably even with large tool lists thanks to schema compression (`MAX_SCHEMA_LEN=6000`) and built-in anti-loop guards.

## Multi-Account & Rate Limits

Free and basic Qwen accounts have per-minute/per-hour request limits. FreeQwenApi supports multiple accounts simultaneously:
- `npm run auth -- --add` — add a new account.
- When the current account hits its limit → the server automatically switches to the next available account (round-robin rotation).
- Account statuses are tracked: `OK` / `WAIT` / `INVALID`.

## Commands Reference

| Command | Description |
|---------|-------------|
| `npm start` | Start the proxy server |
| `npm run auth -- --add` | Add a new Qwen account (opens browser) |
| `npm run auth -- --list` / `--remove` | View or remove saved accounts |
| `npm run auth -- --relogin` | Refresh expired tokens without full re-setup |
| `npm run models:sync` | Fetch the latest model list from Qwen Chat |
| `npm run smoke` | Quick API health check (health + chat) |
| `npm test` | Run 46 unit tests (Node.js test runner, no browser) |
| `npm run lint` / `format` | Code style checks (ESLint + Prettier) |

## Limitations & Caveats

- **Unofficial proxy.** Qwen may change site structure or internal API URLs at any time. The project adapts to these changes, but you may need to pull updates from the repository.
- **Stale personalization context.** If your Qwen account has accumulated many old conversations and personalization data, the model (especially `qwen3.7-max`) may occasionally ignore instructions and respond with plain text instead of tool calls. Clearing site cookies/cache in your browser or switching to `qwen3-coder-plus` resolves this instantly.
- **Race condition ("in progress").** Qwen processes SSE sessions for a few seconds after delivering the full response. If you send the next request within milliseconds, the server returns `"chat is in progress"`. FreeQwenApi automatically pauses (~1-2s) and retries on the same chat to preserve conversation context (see docs).
- **Browser memory.** During very long continuous sessions (>100 consecutive calls), Chromium consumes more RAM. The built-in garbage collector closes pages idle for more than 5 minutes, and a hard limit of 5 concurrent pages prevents OOM crashes. Automatic restart triggers when RSS exceeds 512 MB.

## Developer Documentation

Full technical documentation on architecture, module structure, and change history:

- [docs/01_STATUS.md](docs/01_STATUS.md) — current system stability status
- [docs/02_ARCHITECTURE.md](docs/02_ARCHITECTURE.md) — data flow diagrams (normal request vs agent-loop + race condition fix)
- [docs/03_CODE_MAP.md](docs/03_CODE_MAP.md) — module map, key interfaces, and config constants
- [docs/04_CHANGELOG.md](docs/04_CHANGELOG.md) — full development history (sessions 1–48)
- [docs/05_OPEN_QUESTIONS.md](docs/05_OPEN_QUESTIONS.md) — open issues, known quirks, and constraints

## Support the Author

If you found this project useful or it saved you time — reach out:
`mandrykinsergey@gmail.com` | [twitch.tv/dnovitv](https://www.twitch.tv/dnovitv)
