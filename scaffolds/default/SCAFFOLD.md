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

Complete one coherent, bounded unit of progress, record evidence, and stop.
