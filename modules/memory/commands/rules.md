---
description: Standing rules (guidelines with reasons) - list, show <name>, check <file|->, render, review. Use check on any text someone else will read before handing it over.
argument-hint: "list | show <name> | check <file|-> | render | review"
---

Run this command and show the user its output:

```bash
{{CORTEX_TSX}} {{CORTEX_REPO}}/bin/cortex-rules.ts $ARGUMENTS
```

A standing rule is a memory with `kind: rule`. It says what to do and why, its scope, and when it applies.
Read the reason before applying a rule: it is a guideline for the cases it was written for, not a blind command.

`check -` reads a draft on stdin and runs every checkable rule on it. Quoted text (lines starting with `>`,
and text inside double quotes) and code are exempt: quotes are reproduced exactly, never cleaned up.
