---
description: The Cortex mesh, comms' link to other nodes - status, start, stop, listen on|off, peers add|remove <host:port>, config alias|port|host <value>, aliases install
argument-hint: "status | start | stop | listen on|off | peers add <host:port> | peers remove <host:port> | config [alias|port|host <value>] | aliases install"
---

Run this command and show the user its output:

```bash
{{CORTEX_TSX}} {{CORTEX_REPO}}/bin/cortex-mesh.ts $ARGUMENTS
```

A node is local-only until it connects: `listen on` lets other nodes dial in, `peers add` dials one, and either starts the daemon; `listen off` and removing the last peer stop it. Messages on this machine never need the daemon.
`stop` shuts the mesh down completely, leaving no Cortex process running; the next session starts it again if the node connects.
`config alias <name>` (or `port`, `host`) stores this node's setting in its mesh folder, so every start uses it, however it is started. The environment (`CKN_NODE_ALIAS`, `CKN_MESH_PORT`, `CKN_MESH_BIND`) still overrides it.
`aliases install` adds `cortex` (start and show status) and `cortex-off` (stop) to the user's shell. Ask before running it.
