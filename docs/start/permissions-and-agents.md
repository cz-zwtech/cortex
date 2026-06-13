---
name: cortex-permissions-and-agents
description: "What an agent can set up for you vs what you hand-edit yourself: the settings.json self-modification boundary"
audience: user
---

# Permissions & agent-driven setup

Cortex sessions run under Claude Code's permission classifier. When you ask a
session to set Cortex up for you, the setup actions split into two classes that
behave differently:

| Class | Examples | Can an agent do it from your prompt? |
|---|---|---|
| **Files & commands** | `git clone`, `npm install`/`start`, `chmod`, `ckn-mesh set`, `ckn-start`, `ckn-mind-sync` | **Yes** — flows on your instruction. |
| **`~/.claude/settings.json` edits** | extra `permissions.allow` grants, custom config | **No** — the classifier treats these as *self-modification*. It demands an explicit in-session OK, and it will **not** let an agent add a `permissions.allow` rule for `settings.json` at all (an agent cannot self-grant). |

**You hand-edit `settings.json` yourself** for the second class — no agent
(bus-directed or in-session) can establish it.

> **Important exemption:** the normal `npm start` install **wires the Cortex
> hooks into `settings.json` automatically** — that write is done by the Cortex
> *server* on boot, which is not an agent tool-call and so is not gated by the
> classifier. A clean install handles the hooks for you. The hand-edit gotcha
> only bites when you ask an *interactive agent* to change `settings.json`
> (e.g. add permission grants or wire a statusline).

## Copy-paste: have a session do the node setup (the promptable parts)

Paste this to a Claude Code session on the new machine:

```
Set this machine up as a Cortex driver node:
1. Clone git@github.com:cz-zwtech/cortex.git to ~/cortex, then `npm install`.
2. `npm start` once so first boot writes the hooks/commands/skills
   into ~/.claude, then stop it.
3. `npm run install-aliases`, then `source ~/.bashrc`.
4. Join the mesh: `ckn-mesh set --peer http://<reachable-peer>:3001`, then `ckn-start`.
Do all of the above. For ANYTHING that needs editing ~/.claude/settings.json
(permission grants or config), STOP and give me the exact lines to add — I will
hand-edit it myself.
```

The session will run 1–4 freely; it will pause and hand you snippets for any
`settings.json` change rather than fail silently.

## Copy-paste: the `settings.json` parts you hand-edit yourself

Open `~/.claude/settings.json` and **merge** these in (don't replace the file).

**Status line** — Cortex ships no statusline and never writes the `statusLine`
key: your statusline is personal config. If you want the bus-watcher dot
(`● bus`) in yours, follow **[the bus-dot guide](../statusline-bus-dot.md)** —
it's a documented opt-in addition to *your* script, and the `statusLine` key is
one of the hand-edits only you can make:

```json
"statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }
```

**Reduce permission prompts** for common Cortex commands — add to the existing
`permissions.allow` array (create it if absent; keep your existing entries):

```json
"permissions": {
  "allow": [
    "Bash(ckn-bus:*)",
    "Bash(ckn-start:*)", "Bash(ckn-stop:*)", "Bash(ckn-status:*)",
    "Bash(ckn-mesh:*)", "Bash(ckn-mind-sync:*)"
  ]
}
```

(Tune to taste — this is *your* security tradeoff. An agent cannot add these for you.)

## Expected behavior if you skip the hand-edits

- **No `permissions.allow` grants** → the session prompts you per-action for
  those commands (normal Claude Code behavior); nothing breaks, just more prompts.
- **Asking an agent to edit `settings.json` anyway** → it refuses / defers to
  you; this is expected, not a bug. Hand-edit is the path.

Related: [[cortex-install]] · [[cortex-trust]] · [[cortex-secrets]]
