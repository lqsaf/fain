---
description: Single-turn profile for providers with a strict daily request cap
mode: all
steps: 1
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---

Use only the task, plan, repository context, and verification evidence included in the prompt.
Do not call tools or request more context. Return the required phase output in this single response.
