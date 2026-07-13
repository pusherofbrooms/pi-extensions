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

Find the highest-value gap in the current phase or goal, close or investigate one bounded gap, record evidence, and stop. Replan when evidence changes.
