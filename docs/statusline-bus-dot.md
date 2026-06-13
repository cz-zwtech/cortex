# The Cortex bus dot (opt-in statusline addition)

Cortex ships **no** statusline and never writes your `settings.json` `statusLine`
key. Your statusline is your personal config — Cortex won't impose one or
overwrite the one you have.

What Cortex *offers* is a single optional **bus indicator** you can drop into a
statusline you already maintain: a green `● bus` when a `ckn-bus watch` Monitor
task is armed for the current session (so peer / cross-machine messages arrive in
real time), or a red `● bus off` when it isn't (messages then only land at prompt
boundaries until you arm the watcher).

This is a copy-paste snippet, not a shipped file. Add only the dot; the rest of
your statusline stays yours.

## The snippet

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

If you have no statusline at all and want a minimal, dot-only one, create a
script that prints just the bus segment and point `statusLine` at it yourself:

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
Cortex will not do this for you.

## Prompt for an installing assistant

If an LLM is helping set up Cortex, this is the instruction to give it:

> Cortex ships no statusline. If the user wants the bus indicator, **add only the
> bus dot** to their existing statusline script — never replace or rewrite it,
> and never write the `statusLine` key in their `settings.json` on their behalf
> (that's their call). Read their current statusline, insert the
> `bus_watcher_armed` function and a `${BUS_SEG}` reference into their existing
> output line, and leave everything else untouched. If they have no statusline
> and want one, offer the minimal dot-only script above and let them wire it up.
