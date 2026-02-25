# Global Pi Extensions

This repo contains two lightweight global extensions for Pi:

1. **`show-system-prompt.ts`**
2. **`web-tools.ts`**

## Installation

These are global Pi extensions loaded from your extensions directory.

### Option 1: Copy individual extension files (safest)

Copy any `.ts` extension file you want into:

- `~/.pi/agent/extensions`

### Option 2: Use this repo as your extensions directory

If you want this repo to be your full global extensions folder:

```bash
git clone git@github.com:pusherofbrooms/pi-extensions.git ~/.pi/agent/extensions
```

If the directory already exists and is already a git repo:

```bash
cd ~/.pi/agent/extensions
git remote add origin git@github.com:pusherofbrooms/pi-extensions.git
git pull origin main
```

## Updating

```bash
cd ~/.pi/agent/extensions
git pull --ff-only
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

## Notes
- Keep secrets out of this repo.
- For environment setup and policy, see `AGENTS.md`.
