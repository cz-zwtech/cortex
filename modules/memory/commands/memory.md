---
description: Search and read Cortex memory - recall <words>, show <id>, list, status, quarantine, release, sweep, retire, captured dialogue
argument-hint: "recall <words> | show <id> [--history] | list [n] | retire <id|name> | status | quarantine | release <hash> | sweep | context search <words> | context window <id> | capture --status"
---

Run this command and show the user its output verbatim:

```bash
{{CORTEX_TSX}} {{CORTEX_REPO}}/bin/cortex-memory.ts $ARGUMENTS
```

Use `recall <words>` for any memory question, then `show <id>` on a hit to read it in full.
Pass plain words: leave out quotes and apostrophes ("globex engineers", not "Globex's engineers").

Memory files that hold only the `cortex:stub` line are pointers. The memory itself is in Cortex,
so search here rather than reading those files.

To take an outdated memory out of recall, use `retire <id|name> [--superseded-by <id>] [--why <text>]`:
it is kept, and `unretire` brings it back. `forget` deletes, and is only for text that must go.

For what was actually said in past sessions (the reasoning behind a decision, the alternatives
discussed), use `context search <words>`, then `context window <block id>` to read the
conversation around a hit. `capture --status` shows whether every session transcript is captured.
