---
name: default
title: Default
description: Generic coherent progress for ordinary goals.
goalShape: general
workflow: worker
reviewEvery: 0
completionPolicy: parent-review
blockedPolicy: external-blocker-only
waitingAllowed: false
mergePolicy: evidence-first
---

Make one coherent unit of progress per continuation. A coherent unit may be a focused change, bounded investigation, review, or small operating cycle. Update durable goal state and stop.

When phases are defined, work only on the current phase. Treat phase completion as a reviewer-gated transition, not overall goal completion; do not advance phases directly.
