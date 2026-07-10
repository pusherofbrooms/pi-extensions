---
name: operations
title: Operations / spinning plates
description: Portfolio-style management for live systems with several concerns that must stay healthy.
goalShape: long-running-operations
workflow: operations
reviewEvery: 5
completionPolicy: strict-parent-review
blockedPolicy: external-blocker-only
waitingAllowed: true
mergePolicy: evidence-first
---

Use an operations portfolio loop. Maintain multiple lanes in structured goal notes when useful: facts/evidence for current state, assumptions for expected passive progress, risks for fragile lanes, blockers for stopped lanes, and nextAction for the next trigger. Each continuation: briefly inspect important lanes, repair any critical broken lane if needed, advance one primary lane with a bounded action, record lane health/evidence/next triggers, and stop. Do not let the most urgent lane permanently starve strategic lanes.

When phases are defined, treat them as strategic milestones. Keep lane work inside the current phase, use phase criteria to define the gate, and wait for reviewer verification before the orchestrator advances to the next phase; do not interpret a healthy lane or phase-ready report as overall goal completion.
