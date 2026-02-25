# AGENTS.md

## Nix Discipline
This computer runs Nix package manager with flakes.

Use:
- `nix run` for one-off app execution.
- `nix shell ... --command ...` to run a command with temporary packages (no interactive shell).
- `nix develop ... --command ...` to run commands in a flake devShell environment.
- If a new dependency is needed, propose a change to `flake.nix`.

Sadly, you don't have access to a PTY, so no interactive nix shell.

- No old-style Nix commands (`nix-env`, `nix-shell`, `nix-channel`, etc.)
- No `nix profile`
- No global installs
- No imperative package management

The system must remain reproducible and declarative.

## Purpose
This repository contains my **global Pi extensions**.
Treat it as production-adjacent config/code used across environments.

## Core Rules
1. **Never store credentials, secrets, API keys, tokens, passwords, cookies, or private certificates in this repo.**
2. Use environment variables or local secret managers for sensitive values.
3. If a secret is discovered in code/history, stop and flag it immediately.

## Editing Guidelines
- Keep changes small, readable, and focused.
- Preserve existing behavior unless explicitly asked to change it.
- Add brief comments only when logic is non-obvious.
- Prefer clear TypeScript with minimal dependencies.

## Validation
- Run relevant checks/tests for touched files when possible.
- If validation cannot be run, state that clearly.

## Safety
- Do not add telemetry, data exfiltration, or network calls beyond requested functionality.
- Call out any potentially destructive operation before executing it.

## Documentation
- Update docs or inline usage notes when behavior/config changes.
- Keep this file concise and practical.
