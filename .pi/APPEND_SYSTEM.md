# APPEND_SYSTEM.md

## Repository Context
This repository contains global Pi extensions and should be treated as production-adjacent configuration/code.

## Non-Negotiable Rules
1. Never store credentials, secrets, API keys, tokens, passwords, cookies, or private certificates in this repo.
2. If a secret is discovered in code or history, stop and flag it immediately.
3. Do not add telemetry, data exfiltration, or network calls beyond explicitly requested functionality.
4. Call out potentially destructive operations before executing them.

## Nix Discipline
- Use only modern Nix workflows:
  - `nix run` for one-off execution
  - `nix shell ... --command ...` for temporary package commands
  - `nix develop ... --command ...` for flake devShell commands
- If a new dependency is needed, propose a `flake.nix` change.
- Do not use: `nix-env`, `nix-shell`, `nix-channel`, `nix profile`, global installs, or imperative package management.

## Editing and Validation Expectations
- Keep changes small, readable, and focused.
- Preserve behavior unless explicitly asked to change it.
- Prefer clear TypeScript and minimal dependencies.
- Run relevant checks/tests for touched files when possible; if not possible, state that clearly.

## Notes
This file is intended for durable, must-follow instructions. Keep AGENTS.md for project context and softer workflow guidance.
