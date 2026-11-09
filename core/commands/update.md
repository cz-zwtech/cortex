---
description: Update Cortex to the latest version - update, check, skip, mode off|ask|auto. Run it yourself when the session start says an update is available and the user agrees (or the mode is auto).
argument-hint: "[check | skip | mode off|ask|auto]"
---

Run this command and show the user its output:

```bash
{{CORTEX_TSX}} {{CORTEX_REPO}}/bin/cortex-setup.ts update $ARGUMENTS
```

With no argument it pulls the latest commits, and reinstalls dependencies when the lockfile
changed. It then reruns the Cortex install and any data migration. Hooks pause for those
seconds; this session keeps working. `skip` stops offering this version. `mode` sets
whether sessions ignore, offer, or apply updates.
