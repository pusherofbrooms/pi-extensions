# Global Pi Extensions

This repo contains lightweight global extensions for Pi:

1. **`show-system-prompt.ts`**
2. **`bash-read-only.ts`**
3. **`web-tools.ts`**
4. **`subagents.ts`**
5. **`openai-codex-image-gen.ts`**
6. **`goal.ts`**

## Installation

Install as a Pi package from git (recommended):

```bash
pi install git:github.com/pusherofbrooms/pi-extensions
```

This keeps your own `~/.pi/agent/extensions` directory clean and lets these extensions cohabitate with other installed packages.

## Updating

```bash
pi update git:github.com/pusherofbrooms/pi-extensions
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

## 2) `bash-read-only`
Adds **`bash_read_only`**, a structured, mostly-safe inspection tool taking `executable`, `args`, and optional `cwd`/`timeoutMs`. It never invokes a shell and denies commands by default. Explicit argument policies cover `ps`, `vmstat`, `uptime`, `uname`, `df`, `free`, `who`, `id`, display-only `date`, bounded `tail` (at most 10,000 lines), bounded query-only `journalctl` (at most 1,000 entries with `--no-pager`), a conservative positive grammar for stdout-only `find` (dangerous action tokens are rejected anywhere in its argument vector), and constrained Git inspection (including leading `-C <dir>` and `--no-pager`). Explicit readable paths and working directories outside the session cwd are permitted; OS permissions govern access. Executable paths, follow/streaming and write modes, unsafe inherited environment variables, Git external execution, excessive runtime, and excessive output are blocked.

Trusted user-global additions may be placed in `~/.pi/agent/bash-read-only.json`; project configuration is intentionally ignored. Additions match the complete argument vector exactly and executable values must be command names resolved only through the fixed system PATH. An addition is an explicit grant to execute that exact command, not proof that the executable is read-only, so add only programs and arguments you trust:

```json
{
  "additions": [
    { "executable": "my-inspector", "args": ["--summary"] }
  ]
}
```

The normal Pi session registers this tool as an extension and may use trusted global additions. Isolated `/goal` observer, researcher, and reviewer sessions receive a factory-configured instance named `goal-bash-read-only` while extension discovery and global additions remain disabled; the goal worker retains ordinary `bash` for implementation. The policy is primarily non-mutating, but inspection commands can have incidental side effects (for example filesystem access-time updates or Git implementation details). This is a defense-in-depth command policy, not an OS sandbox.

## 3) `web-tools`
Adds two tools:

- **`web_search`**: web search with provider selection via env var
- **`fetch_page`**: fetches a public URL and extracts its main content as Markdown with Defuddle

### `web_search` providers
Set `WEB_SEARCH_PROVIDER` to one of:

- `duckduckgo` (default, no API key)
- `brave` (requires `BRAVE_API_KEY`)
- `tavily` (requires `TAVILY_API_KEY`)
- `serpapi` (requires `SERPAPI_API_KEY`)

Optional:

- `WEB_TOOL_TIMEOUT_MS` (default `15000`)
- `WEB_TOOL_USER_AGENT`
- `WEB_FETCH_ALLOWED_HOSTS` (comma-separated fetch allowlist; unset or empty allows all public hosts)

### Fetch host allowlist

By default, `fetch_page` may fetch any public HTTP(S) host. Set `WEB_FETCH_ALLOWED_HOSTS` to restrict it:

```bash
export WEB_FETCH_ALLOWED_HOSTS="docs.github.com,*.wikipedia.org,developer.mozilla.org"
```

Entries are either exact hostnames or `*.` subdomain patterns. `*.wikipedia.org` allows hosts such as `en.wikipedia.org`, but not the apex `wikipedia.org`; list the apex separately if needed. A lone `*` explicitly allows every public host. Schemes, paths, ports, and other glob forms are rejected. The allowlist is checked for the initial URL and every redirect.

### Safety behavior
`fetch_page` includes SSRF protections in addition to the optional allowlist:

- blocks localhost / private IP targets
- validates DNS resolution to avoid private-network hosts
- only allows `http` / `https`

HTML pages are parsed with Defuddle and LinkeDOM without executing JavaScript. Defuddle's optional third-party fallback services are disabled. Interactive and client-rendered pages should use `agent-browser` instead.

As a temporary workaround for a Defuddle 0.19.1 regression introduced by commit `43cc4cb`, content-pattern removal is disabled for Wikipedia domains so later article sections are retained.

Output is truncated to Pi defaults (about 50KB / 2000 lines), with full Markdown saved to a temp file when truncation occurs.

## 4) `subagents`
Adds a subagent tool and command helpers:

- **`subagent`**: runs named agents in isolated persisted Pi sessions (single, parallel, chain). Its model-facing description dynamically lists discovered agent names, descriptions, sources, and allowed tools so callers can choose a valid, capable agent.
- **`/agents`**: lists discovered agents and their source.
- **`/agent <name> <task>`**: run any discovered agent by name.
- Dynamic aliases like **`/scout ...`** or **`/worker ...`** are auto-registered when command names do not conflict.
- Command-based runs (`/agent ...` and aliases) emit start/finish notifications in the chat area so long-running work is visible.
- Each subagent result includes the persisted Pi `sessionFile` path in tool/message details for later audit or self-improvement.

Generic `subagent` remains freeform by default. Agents may be asked in their task text or agent prompt to return JSON, but the tool does not currently enforce report contracts or parse structured output. The structured report-contract machinery is intentionally kept in `/goal`, where lifecycle authority, validation, and merge policy are explicit. Optional generic report-contract mode is deferred until there is a concrete non-goal use case so existing `/agent`, alias, single, parallel, and chain behavior does not change unexpectedly.

### Agent files
Discovery order (by name override):

1. Built-in defaults from this package (`scout`, `planner`, `worker`, `reviewer`)
2. User agents: `~/.pi/agent/agents/*.md`
3. Project agents (optional): `.pi/agents/*.md`

Internal `/goal` protocol roles live separately under `goal-agents/`. They are loaded directly by the goal orchestrator and are not exposed through `/agents`, `/agent`, aliases, or the generic `subagent` tool.

Frontmatter format:

```md
---
name: worker
description: General-purpose implementation agent
tools: read, grep, find, ls, bash, edit, write
# model: provider/model-id   # optional
# thinking: low              # optional: off|minimal|low|medium|high|xhigh|max
---

You are a focused coding worker...
```

If `model` is omitted, subagents use the current session model. If the `thinking` key is omitted, they inherit the parent session's active thinking level; an explicit valid `thinking` value overrides inheritance. Pi clamps the selected level to the subagent model's capabilities. Blank, non-string, and unknown values fail the delegated run with a clear error. Internal goal roles do not use this generic-agent frontmatter override; they uniformly inherit the parent level for each continuation.

## 5) `openai-codex-image-gen`
Adds **`generate_openai_image`**, an image-generation tool that uses Pi's existing `openai-codex` OAuth credentials.

- Authenticate with `/login` for the OpenAI Codex provider first.
- Default save mode is `none`; use `save=project`, `save=global`, or `save=custom` to write PNG files.
- Optional environment/config knobs: `PI_OPENAI_IMAGE_SAVE_MODE`, `PI_OPENAI_IMAGE_SAVE_DIR`, `PI_OPENAI_IMAGE_MODEL`.

## 6) `goal`
Adds a tool-backed autonomous `/goal` workflow.

Commands:

- `/goal <objective>` starts or replaces the active project goal.
- `/goal --max <n> <objective>` starts with an iteration cap.
- `/goal` or `/goal status` shows current goal state.
- `/goal help` shows command help.
- `/goal pause`, `/goal resume`, `/goal clear`, `/goal complete` control status.
- `/goal max <n>` or `/goal max none` adjusts the current cap.
- `/goal more <n>` or `/goal --more <n>` adds N more iterations to the current cap; if the goal was paused because it reached the cap, this resumes and queues continuation.
- `/goal review-every <n>` or `/goal review-every none` enables/disables periodic strategic review prompts.
- `/goal scaffolds` lists available scaffolds.
- `/goal scaffold <id>` selects a scaffold for the current goal.
- `/goal scaffold status` shows the current scaffold.

### Quick start

```text
/goal Write a short tragic tale about goblins and Rust to /tmp/goblins-rust.md
```

For a bounded coding task:

```text
/goal --max 5 Build and test a small static web app in /tmp/my-app
```

Use `/goal status` to inspect progress. The model-facing `goal_phases` tool defines ordered phases; workers stay within the current phase, and reviewer evidence is required before the orchestrator advances to the next one.

### State and execution

The extension stores durable goal state under `~/.pi/agent/goals/` with a single index file mapping projects to current goals. `/goal` command invocations are also recorded as TUI-only chat entries rendered like user messages, without adding command text to the LLM context. It exposes `get_goal`, `goal_note`, `goal_phases`, `goal_criteria`, `goal_criterion_update`, `goal_review`, `goal_block`, and `update_goal` tools. Phases are ordered and evidence-gated; workers may propose readiness, but only reviewer/orchestrator logic advances the current phase. `get_goal` is intended for explicit goal work or autonomous continuation; when the last goal is complete or cleared, it returns a short `NO_ACTIVE_GOAL` response rather than injecting terminal history into unrelated work. `goal_review` accepts structured evidence and per-criterion assessments, so manually recorded terminal reviews use the same evidence model as delegated reviews; it records readiness but `update_goal` remains the explicit completion command. Autonomous continuations run through an internal goal worker in a fresh persisted Pi session that inherits the parent session's active thinking level so bulky execution context stays out of the parent chat while the raw subagent session remains auditable. Each goal role receives a compact context projection suited to its work: worker, observer, researcher, completion-reviewer, and strategic-reviewer profiles select reusable state sections and omit empty values; unknown future roles fall back to the safe worker profile, while a comprehensive audit profile remains available for explicit diagnostics. Scaffolds continue to define operating method rather than arbitrary access to stored goal fields. The parent extension records each worker report, owns lifecycle state, and queues follow-up worker turns until the goal is complete, paused, blocked, cleared, or max iterations are reached.

### Completion and review

For long-horizon goals, the model or delegated worker can define/update evidence-bearing success criteria, record structured facts/assumptions/risks/blockers/evidence, and perform terminal reviews. Goal JSON also keeps a bounded `iterations` list with each delegated step's outcome, compact evidence, next action, roles, and references to the persisted Pi session files for worker/parent-reviewer runs. `update_goal` refuses model-driven completion until criteria are passed with evidence and the latest review says `ready_to_complete`; delegated workers can only propose readiness. When a worker proposes completion, the parent first runs readiness checks, then performs a concise parent-review pass before marking the goal complete and posting brief completion commentary.

### Continuation policy

The default continuation policy is intentionally generic: make one coherent unit of progress, update durable state, and stop. A coherent unit can be a focused change, bounded investigation, review, or an operating cycle that checks several live concerns and advances one primary concern.

Goal scaffolds customize the continuation method. The bundled scaffold IDs are:

- **`default`** — generic bounded progress.
- **`zenith`** — linear gap-closing with review discipline.
- **`operations`** — long-running portfolio/lane management. The ID is `operations`, not `operational`.

Bundled scaffolds are installed under `scaffolds/<id>/SCAFFOLD.md`. Custom scaffolds can be added at `~/.pi/agent/scaffolds/<id>/SCAFFOLD.md` or project-local `.pi/scaffolds/<id>/SCAFFOLD.md`; project scaffolds override user scaffolds, which override bundled scaffolds. `/goal scaffold <id>` selects an existing scaffold for the active goal. A phase may also name its own scaffold through `goal_phases`.

Scaffold files are Markdown with optional simple frontmatter:

```md
---
name: operations
title: Operations / spinning plates
description: Portfolio management for live systems with several concerns that must stay healthy.
---

Use this scaffold when a goal has multiple active lanes rather than one linear gap.

Each continuation should:
1. Briefly inspect important lanes.
2. Repair any critical broken lane if needed.
3. Advance one primary lane with a bounded action.
4. Record lane health, evidence, next triggers, and stop.
```

Only flat `key: value` frontmatter is parsed. The Markdown body is injected into the goal continuation prompt as the scaffold's operating method.

## Testing

This repo includes lightweight unit tests for pure extension support logic.

Run with Nix:

```bash
nix develop --command npm test
```

Current tests include:
- `tests/bash-read-only.test.ts` (policy, confinement, and no-shell execution)
- `tests/secret-detection.test.mjs` (goal-state secret detection)
- `tests/goal-core.test.mjs` (goal criteria, phase, and review helpers)
- `tests/goal-integration.integration.mjs` (mocked `/goal` orchestration and lookup flows)
- `tests/subagent-catalog.test.ts` (model-facing agent capability catalogue)
- `tests/web-tools.test.ts` (web extraction behavior)

Recommended test strategy for extensions:
1. **Unit tests** for pure logic (regex/policy decision code).
2. **Mocked integration tests** for `/goal` orchestration without LLM calls:
   ```bash
   nix develop --command node --experimental-strip-types \
     --experimental-loader ./tests/goal-integration-loader.mjs \
     --test tests/goal-integration.integration.mjs
   ```
3. **Targeted smoke tests** in a real `pi` session for event-hook behavior.

## Notes
- Keep secrets out of this repo.
- For environment setup and policy, see `AGENTS.md` and `.pi/APPEND_SYSTEM.md`.
