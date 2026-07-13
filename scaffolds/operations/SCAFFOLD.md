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

Inspect lane health, repair critical regressions, then advance one primary lane. Record current state, trajectory, evidence, and the next trigger. Avoid starving strategic lanes.
