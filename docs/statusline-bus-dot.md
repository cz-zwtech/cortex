# Cortex statusline dots (opt-in additions)

Cortex ships **no** statusline and never writes your `settings.json` `statusLine`
key. Your statusline is your personal config — Cortex won't impose one or
overwrite the one you have.

What Cortex *offers* is two optional **indicators** you can drop into a statusline
you already maintain:

- **bus dot** — a green `● bus` when a `ckn-bus watch` Monitor task is armed for
  the current session (so peer / cross-machine messages arrive in real time), or a
  red `● bus off` when it isn't (messages then only land at prompt boundaries until
  you arm the watcher).
- **mesh dot** — a **binary, link-aware** "am I on the mesh" signal (not a peer
  count): green `● mesh` when the tier is live with at least one live link, red
  `● mesh…` when armed but not yet connected (token/VPN not up), yellow `○ local`
  when the mesh is off by choice, dim `○ mesh` when the local server can't be
  reached. It reads `enabled` + `live` + (`wsLinks[].connected` OR a reachable
  canonical-http `peers[]`) from the local `/api/bus/mesh-status` diagnostic. A
  count is deliberately avoided: a NAT'd node (WSL / a laptop on its own LAN)
  reaches the fleet by relaying through a hub, so a direct-dial reachable count
  shows 1-of-N even when the whole fleet is up — link-aware avoids that lie.

Both are copy-paste snippets, not shipped files. Add only the dot(s); the rest of
your statusline stays yours.

## The bus dot snippet

Claude Code passes the statusline script a JSON blob on stdin that includes
`.session_id`. This function scans `/proc` for a live `ckn-bus watch` bound to
that session (by `--session` arg or the `CLAUDE_CODE_SESSION_ID` environ —
mirroring `watcherRunningForSession` in `bin/ckn-pause-context.ts`):

```bash
# --- Cortex bus dot: armed ckn-bus watch detector ---------------------------
# Returns 0 (armed) when a `ckn-bus watch` Monitor task is running for $1 (the
# session id), else 1. Pure /proc scan; no network, no Cortex dependency.
bus_watcher_armed() {
  local sid="$1" pid cmd
  [ -z "$sid" ] && return 1
  for pid in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$pid/cmdline" 2>/dev/null) || continue
    case "$cmd" in
      *ckn-bus*watch*)
        case "$cmd" in *"$sid"*) return 0 ;; esac          # bound via --session arg
        if tr '\0' '\n' < "$pid/environ" 2>/dev/null | grep -q "^CLAUDE_CODE_SESSION_ID=$sid$"; then
          return 0                                         # or via environ
        fi
        ;;
    esac
  done
  return 1
}

# Render the dot. SESSION_ID comes from the statusline JSON: SESSION_ID=$(echo "$input" | jq -r '.session_id // empty')
GREEN='\033[32m'; RED='\033[31m'; RST='\033[0m'
if bus_watcher_armed "$SESSION_ID"; then
  BUS_SEG="${GREEN}● bus${RST}"
else
  BUS_SEG="${RED}● bus off${RST}"
fi
# ...then include "$BUS_SEG" wherever you want it in your printf line.
# --- end Cortex bus dot ------------------------------------------------------
```

## Adding it by hand

1. Open your statusline script (whatever `statusLine.command` in
   `~/.claude/settings.json` points at). If you don't have one, see "No
   statusline yet?" below.
2. Near the top, make sure `SESSION_ID` is parsed from stdin:
   `SESSION_ID=$(echo "$input" | jq -r '.session_id // empty')`.
3. Paste the `bus_watcher_armed` function and the `BUS_SEG` block.
4. Reference `$BUS_SEG` in your existing `printf` output line, wherever you want
   the dot to appear. **Don't replace your line — just add the segment.**

Everything else in your statusline is yours; this only adds the dot.

### No statusline yet?

The quickest path is the opt-in installer: **`ckn-statusline`** (added by
`npm run install-aliases`). With no statusline configured it offers to scaffold a
minimal, Cortex-dots-only script at `~/.config/ckn/statusline.sh` and wire the
`statusLine` key — only on your explicit consent (`--yes`, or an interactive yes).
If you already have a statusline it prints the paste-in snippet instead and never
touches your file. Pick the dots with `--dots bus,mesh` (default both). Cortex
writes nothing unless you opt in.

Prefer to do it by hand? Create a script that prints just the segment and point
`statusLine` at it yourself:

```bash
#!/bin/bash
input=$(cat)
SESSION_ID=$(echo "$input" | jq -r '.session_id // empty')
# (paste bus_watcher_armed here)
GREEN='\033[32m'; RED='\033[31m'; RST='\033[0m'
if bus_watcher_armed "$SESSION_ID"; then printf '%b\n' "${GREEN}● bus${RST}"
else printf '%b\n' "${RED}● bus off${RST}"; fi
```

Then set it in `~/.claude/settings.json` yourself:
`"statusLine": { "type": "command", "command": "bash ~/.claude/your-statusline.sh" }`.
By hand, Cortex won't touch your `settings.json` — that's what `ckn-statusline`
automates, on consent.

## The mesh dot snippet

The mesh dot reads the **local, auth-free** `/api/bus/mesh-status` diagnostic and
shows the OUTCOME of the membership tick, not just configured intent: it keys off
`enabled` (armed), `live` (the tier is up), and whether there is **at least one live
link** — a connected `wsLinks[]` OR a reachable canonical-http `peers[]`. It counts
links, not peers, and shows no number: a NAT'd node relays through a hub, so a
direct-dial reachable count reads 1-of-N even with the fleet up. `enabled` alone is
*not* a connection — the dot distinguishes armed-but-retrying from connected.

```bash
# --- Cortex mesh dot: binary, link-aware "on the mesh?" ---------------------
# Needs the color vars below in scope. jq + curl; one bounded local read (~9ms),
# never a tsx/ckn-bus spawn — a statusline runs on every prompt.
GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; DIM='\033[2m'; RST='\033[0m'
mesh_seg() {
  local j enabled live linked
  j=$(curl -s --max-time 1 http://localhost:3001/api/bus/mesh-status 2>/dev/null)
  [ -z "$j" ] && { printf '%s' "${DIM}○ mesh${RST}"; return; }
  enabled=$(printf '%s' "$j" | jq -r '.enabled // false')
  live=$(printf '%s' "$j" | jq -r '.live // false')
  linked=$(printf '%s' "$j" | jq -r '[(.wsLinks[]?|select(.connected==true)), (.peers[]?|select(.reachable==true and (.url|startswith("http"))))] | length')
  if [ "$enabled" = "true" ] && [ "$live" = "true" ] && [ "${linked:-0}" -ge 1 ]; then
    printf '%s' "${GREEN}● mesh${RST}"
  elif [ "$enabled" = "true" ]; then
    printf '%s' "${RED}● mesh…${RST}"
  else
    printf '%s' "${YELLOW}○ local${RST}"
  fi
}
MESH_SEG=$(mesh_seg)
# ...then include "$MESH_SEG" wherever you want it in your printf line.
# --- end Cortex mesh dot ----------------------------------------------------
```

The four states: green `● mesh` (connected — directly or via a relay hub), red
`● mesh…` (armed but the tick is retrying — token/VPN not up), yellow `○ local`
(mesh off by choice), dim `○ mesh` (local server unreachable, can't determine). Add
it exactly like the bus dot: paste the function and the `MESH_SEG` line into your
statusline script and reference `$MESH_SEG` in your `printf` line — don't replace
your line. It needs `jq` (already used to parse the stdin JSON) and `curl`. Unlike
the bus dot it makes one local HTTP call per render; the 1s cap means a stopped
server costs at
most a second and shows the dim dot.

## Prompt for an installing assistant

If an LLM is helping set up Cortex, this is the instruction to give it:

> Cortex ships no statusline. If the user wants an indicator, **add only the dot
> they asked for** to their existing statusline script — never replace or rewrite
> it, and never write the `statusLine` key in their `settings.json` on their behalf
> (that's their call). For the **bus dot**, read their current statusline and insert
> the `bus_watcher_armed` function and a `${BUS_SEG}` reference into their existing
> output line. For the **mesh dot**, insert the `mesh_seg` function and a
> `${MESH_SEG}` reference the same way — it shows green `● mesh` when connected
> (directly or via a relay hub), red `● mesh…` when armed-but-retrying, yellow
> `○ local` when off, dim `○ mesh` when
> the server is unreachable. Leave everything else untouched. If they have no
> statusline and want one, offer the minimal dot-only script above and let them wire
> it up.
