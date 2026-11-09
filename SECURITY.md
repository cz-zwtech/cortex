# Security

Cortex holds things that matter: memories, messages between machines, and the keys of a gateway.
If you find a way to read, change or send any of them without the access you should need, please
tell us privately first.

## Reporting a vulnerability

Use this repository's private vulnerability reporting (the Security tab, "Report a vulnerability").
Please include what you found, how to reproduce it, and what it lets someone do. We will
acknowledge your report and keep you posted as we look into it.

Please do not open a public issue for a vulnerability until it is fixed.

## What is in scope

- Secrets leaving a machine: memory, comms and the mesh scan what they carry for secrets, and a
  gateway holds outbound messages for review.
- The gateway: peer messages are data, never commands; only exposed roles are reachable; links
  are mutually authenticated and pinned.
- Private mind: what a node keeps home must never leave it, and nothing syncs through a gateway.
- Install and update: Cortex must never write outside its state, its checkout and the parts of
  your Claude Code config it says it manages.
