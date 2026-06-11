# FreeQwenApi — Status (2026-06-11)

## Health: GREEN

All core paths operational. 50+ development sessions across 5 days (June 7–11). No blocking issues.

| Area | Status | Notes |
|------|--------|-------|
| Tool calling (SSE + streaming) | Working | Anti-loop guards, chunk splitting, parse reliability |
| Agent-loop stability | Working | Deferred auto-reset, cooldown, same-chat retry on "in progress" |
| Chat management | Working | S46: resolveQwenChatId creates chat when no default exists. invalidateQwenChatId cleans ALL maps on "not exist" error. Early mapChatId (S57) saves mapping before SSE timeout loses it. |
| Page pool memory | Mitigated | Hard limit 5 pages, idle TTL 5min, periodic GC every 60s, Memory Guard RSS restart |
| Timeout enforcement | Active | `REQUEST_TIMEOUT_MINUTES` (5m) wrapper + protocolTimeout synced at ~180s+ CDP limit. SSE reader abort 3min (S57). |
| CAPTCHA resolver | Working | S52: centralized `resolveCaptchaAndRetry()`, JWT inject, `SIMULATE_CAPTCHA` test mode |
| Unit tests | Passing | 46/46 (`npm test`) |
| ESLint | Clean | 0 errors, ~37 warnings (known unused imports — tech-debt) |
| Prettier | Formatted | All files clean |
| CAPTCHA handling | Active | Visible browser resolver + reader timeout guard against stream hangs |
| Aliyun WAF bypass | Working | All API requests via `evaluateInBrowser` (page.evaluate fetch) — WAF sees legitimate browser context |
| Account binding | Working | chatTokenOwner Map, resolveAuthToken(preferredOwner) — chats belong to the account that created them |
| Multi-account management | Working | Add account clears old token + saves per-account dir. Relogin restores from cookies first, then manual fallback |

## Critical Architecture Changes (June 11)

### Full browser-evaluate path (Aliyun WAF bypass)
All API requests to Qwen now execute via `evaluateInBrowser()` inside Chromium tabs. Node.js `fetch` is blocked by Aliyun WAF (returns HTML instead of SSE/JSON). Running `fetch()` inside `page.evaluate()` makes requests appear as legitimate browser traffic — WAF passes them through, SSE streams flow uninterrupted for up to 5 minutes.

### Increased timeouts
- Proxy global limit: **5 min** (`REQUEST_TIMEOUT_MINUTES` in config.js)
- CDP protocol timeout: calculated from REQUEST_TIMEOUT (~180s+ minimum) so long SSE generations don't break the connection
- `evaluateInBrowser` default: same as `executeApiRequest` apiTimeoutMs (≥ 180s)

### Hard account-to-chat binding
Each Qwen chat is tied to the token that created it (`setChatTokenOwner`). When sending messages, the proxy resolves ownership via `getChatTokenOwner(realQwenChatId)` and passes `preferredOwnerId` to `resolveAuthToken()`. Without this, token rotation would pick random accounts → "not exist" errors on other accounts' chats.

### Account management overhaul
- **Add account**: clears stale global `auth_token.txt`, launches visible browser, waits for user login, extracts + saves token per-account in `session/accounts/{id}/token.txt`, updates tokenManager list, restarts headless.
- **Relogin account**: loads saved cookies FIRST (`cookies.json`), restores session if alive → no manual re-entry needed. If cookies dead → shows login page for user to authenticate manually. Saves new cookies + updates token in tokenManager.

## Quick Start

```bash
node index.js          # launches browser, waits for manual auth
npm test               # unit tests (no browser required)
npm run lint           # ESLint check
npm run format         # Prettier write
node scripts/auth.js   # account management CLI: --list, --add, --relogin, --remove
```
