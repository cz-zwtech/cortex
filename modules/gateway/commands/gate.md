---
description: The domain gateway (run on the gateway node) - status, key, check, paths, audit
argument-hint: "status | key | check | paths [--all] | audit [--tail N] [--verify]"
---

Run this command and show the user its output:

```bash
{{CORTEX_TSX}} {{CORTEX_REPO}}/modules/gateway/bin/cortex-gate.ts $ARGUMENTS
```

The gateway is the only path between this Cortex and another owner's. `key` prints this gateway's pin for a peer
gateway's owner to pin by hand; never print or copy the key file itself.
