---
name: zenith
title: Zenith-style gap closer
description: Repeated gap finding, evidence, and stopping discipline for linear long-horizon work.
goalShape: linear-long-horizon
workflow: worker-reviewer
reviewEvery: 5
completionPolicy: strict-parent-review
blockedPolicy: external-blocker-only
waitingAllowed: false
mergePolicy: evidence-first
---

Use a Zenith-style control loop. Each continuation: inspect current state, compare it to the original objective and success criteria, identify the most important remaining gap, close or investigate one bounded gap, record evidence, and stop. Replan when evidence changes. Do not complete without passed criteria and a ready terminal review.

When phases are defined, constrain gap-finding and execution to the current phase. A phase gate requires reviewer evidence for every current-phase criterion before the orchestrator advances to the immediate next phase; phase readiness is not overall goal completion.
