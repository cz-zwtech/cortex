---
description: Bring the status line onto the Cortex V2 segment - status, apply, decline. Run it yourself when the session start asks and the user agrees.
argument-hint: "status | apply | decline"
---

Run this command and show the user its output:

```bash
{{CORTEX_TSX}} {{CORTEX_REPO}}/bin/cortex-setup.ts statusline $ARGUMENTS
```

`apply` keeps the user's own status line. It appends the Cortex segment through a small wrapper
script and blanks any old V1 dots. It backs up every file it changes, and checks that the result
renders before keeping it. `decline` records the answer, so the question is not asked again.
