# AGENTS.md

## Purpose
This repository contains my **global Pi extensions**.
Treat it as production-adjacent config/code used across environments.

## Working Style
- Keep changes small, readable, and focused.
- Preserve existing behavior unless explicitly asked to change it.
- Add brief comments only when logic is non-obvious.
- Prefer clear TypeScript with minimal dependencies.

## Validation & Docs
- Run relevant checks/tests for touched files when possible.
- If validation cannot be run, state that clearly.
- Update docs or inline usage notes when behavior/config changes.

## Testing Workflow (Preferred)
- Prefer TDD for new logic and bug fixes when practical.
- At minimum, add or update tests for behavior changes.
- Keep tests focused, fast, and easy to run in the Nix dev environment.

## Commit & Push Workflow (Preferred)
- After relevant tests pass, commit and push unless explicitly asked not to.

