# Global Pi Extensions

This repo contains lightweight global extensions for Pi:

1. **`show-system-prompt.ts`**
2. **`web-tools.ts`**
3. **`guardrails.ts`**

## Installation

Install as a Pi package from git (recommended):

```bash
pi install git:github.com/pusherofbrooms/pi-extensions
```

This keeps your own `~/.pi/agent/extensions` directory clean and lets these extensions cohabitate with other installed packages.

## Updating

```bash
pi update
```

## Uninstall

```bash
pi remove git:github.com/pusherofbrooms/pi-extensions
```

> Set provider API keys in your shell environment (not in this repo).

## 1) `show-system-prompt`
Adds a command named **`show-system-prompt`**.

- Default behavior: opens the effective system prompt in Pi’s editor UI.
- Non-UI mode: prints the system prompt to stdout.
- `show-system-prompt save`: writes a snapshot to:
  - `.pi/system-prompt.snapshot.md` (under current working directory)

## 2) `web-tools`
Adds two tools:

- **`web_search`**: web search with provider selection via env var
- **`fetch_page`**: fetches a public URL and extracts readable text

### `web_search` providers
Set `WEB_SEARCH_PROVIDER` to one of:

- `duckduckgo` (default, no API key)
- `brave` (requires `BRAVE_API_KEY`)
- `tavily` (requires `TAVILY_API_KEY`)
- `serpapi` (requires `SERPAPI_API_KEY`)

Optional:

- `WEB_TOOL_TIMEOUT_MS` (default `15000`)
- `WEB_TOOL_USER_AGENT`

### Safety behavior
`fetch_page` includes SSRF protections:

- blocks localhost / private IP targets
- validates DNS resolution to avoid private-network hosts
- only allows `http` / `https`

Output is truncated to Pi defaults (about 50KB / 2000 lines), with full text saved to a temp file when truncation occurs.

## 3) `guardrails`
Adds lightweight runtime safety checks without changing day-to-day workflow.

### Behavior
- Intercepts **`write`** and **`edit`** tool calls.
- Blocks writes when content looks like a likely secret (e.g., private key blocks, AWS keys, PAT-style tokens, JWTs, obvious `api_key`/`token` assignments).
- Intercepts **`bash`** tool calls.
- Prompts only for clearly dangerous commands (e.g., `rm -rf`, `mkfs`, destructive `dd`, `git reset --hard`, destructive `git clean`, reboot/shutdown patterns).

### UX model
- Safe/normal commands: no prompt.
- Dangerous bash command in interactive mode: **one-time allow** prompt.
- Dangerous bash command in non-interactive mode: blocked by default.

## Testing

This repo includes lightweight unit tests for guardrail detection logic.

Run with Nix:

```bash
nix develop --command node --test tests/*.test.mjs
```

Current tests:
- `tests/guardrails-core.test.mjs` (secret/dangerous-command detection)

Recommended test strategy for extensions:
1. **Unit tests** for pure logic (regex/policy decision code).
2. **Targeted smoke tests** in a real `pi` session for event-hook behavior.

## Notes
- Keep secrets out of this repo.
- For environment setup and policy, see `AGENTS.md` and `.pi/APPEND_SYSTEM.md`.
