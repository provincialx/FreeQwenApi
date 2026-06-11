!Temporaly not working, captcha trouble!

# FreeQwenApi — Documentation Index

| File | Content | Last updated |
|------|---------|-------------|
| [01_STATUS.md](./01_STATUS.md) | Health table, quick start commands, critical architecture changes summary (WAF bypass, timeouts, account binding) | 2026-06-11 |
| [02_ARCHITECTURE.md](./02_ARCHITECTURE.md) | System overview + mermaid sequence diagrams for normal flow and agent-loop with "in progress" race handling. Account-to-chat ownership binding, timeout architecture (3 layers), CAPTCHA/WAF resolver flow, account management flows | 2026-06-11 (S55-S56) |
| [03_CODE_MAP.md](./03_CODE_MAP.md) | Module layout, key interfaces, dependency graph, LOC sizes, config constants, evaluate helpers table, account storage disk layout | 2026-06-11 (S55-S56) |
| [04_CHANGELOG.md](./04_CHANGELOG.md) | Session history grouped by category: recent stabilization, tool calling, agent-loop stability, refactoring, critical bugs, infrastructure | Sessions 1–56 |
| [05_OPEN_QUESTIONS.md](./05_OPEN_QUESTIONS.md) | Active tech-debt items (D1-D10), resolved issues archive, behavioral quirks, design constraints (WAF/browser-fetch mandate, page pool locks), API compatibility notes for external clients + Agent skill rules (S50) | 2026-06-11 (S55-S56)

> Source material: `../.agent-brief.md` — raw session log with inline debugging traces and commit references. This structured docs extracted from **50+ development sessions** across June 7–11, 2026.

## Key architecture changes since S48

- **S53**: Aliyun WAF detection (both Qwen CAPTCHA + Cloud WAF share resolver)
- **S54**: CDP timeout protection — all `page.evaluate()` wrapped with `evaluateWithTimeout` / `evaluateInBrowser`
- **S55**: Full browser-evaluate migration, account binding (`chatTokenOwner`), 5-min timeouts, account management overhaul
- **S56**: Documentation sync across all files
