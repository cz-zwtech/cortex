#!/usr/bin/env bash
# Transcript capture in a throwaway container (private mind build step 1).
# Nothing here touches a real home, a real Cortex or real memory: the
# transcripts are made up, written into the container's own ~/.claude.
#
# Proves: a full install wires the capture hooks; Stop captures the running
# session's transcript; status flags a transcript near Claude Code's cleanup
# horizon and the session-start catch-up captures it; a headless run is
# skipped; secrets never reach the store; a bus message between two sessions
# lands in the comms dialogue feed and is captured as dialogue; search finds
# it and a window shows it beside the transcript.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$SRC/node_modules" ] && { echo "node_modules in $SRC is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-capturesim.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=capturesim-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
waitcheck() { local what=$1 secs=$2; shift 2; for _ in $(seq 1 "$secs"); do "$@" >/dev/null 2>&1 && { ok "$what"; return; }; sleep 1; done; no "$what"; }
cleanup() { docker rm -fv $P >/dev/null 2>&1; }
cleanup

docker run -d --init --name $P -v $SRC:/src:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null
Z() { docker exec $P bash -c "$1"; }
U() { docker exec $P runuser -l alex -c "cd /opt/cortex; $1"; }
T='node_modules/.bin/tsx'
PROJ='~/.claude/projects/-home-alex-work'

echo "== setup: one user, a full install, made-up transcripts"
Z 'useradd -m -s /bin/bash alex
   mkdir -p /opt/cortex && cd /src && git -c safe.directory=* ls-files -co --exclude-standard | tar -cf - -T - | tar -xf - -C /opt/cortex
   cp -a /src/node_modules /opt/cortex/ && chown -R alex /opt/cortex'
U "$T bin/cortex-install.ts --single-user --no-mesh-start >/tmp/install.out 2>&1"
check "install wires the capture hooks (Stop, SessionStart, SessionEnd through the dispatcher)" U "grep -q cortex-hook.ts ~/.claude/settings.json && grep -q on-capture-stop modules/memory/module.json"
U "node -e \"const f=require('os').homedir()+'/.claude/settings.json';const s=JSON.parse(require('fs').readFileSync(f));s.cleanupPeriodDays=30;require('fs').writeFileSync(f,JSON.stringify(s))\""

line() { printf '%s\n' "$1"; }
mk() { # file, then JSONL lines on stdin
  docker exec -i $P runuser -l alex -c "mkdir -p $PROJ && cat >> $PROJ/$1"
}
TS='"timestamp":"2026-10-01T12:00:00Z"'
{
  line '{"type":"custom-title","customTitle":"alpha-dev-1","sessionId":"live"}'
  line '{"type":"user","uuid":"l1",'"$TS"',"sessionId":"live","entrypoint":"cli","message":{"content":"Why not RabbitMQ for the job queue?"},"origin":{"kind":"human"}}'
  line '{"type":"assistant","uuid":"l2",'"$TS"',"message":{"id":"m1","content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"Ordering per key matters more, so the append-only log wins."}]}}'
  line '{"type":"user","uuid":"l3",'"$TS"',"message":{"content":"my token is AKIAABCDEFGHIJKLMNOP, keep it out"},"origin":{"kind":"human"}}'
} | mk live.jsonl
{
  line '{"type":"user","uuid":"o1","timestamp":"2026-09-02T09:00:00Z","sessionId":"old","entrypoint":"cli","message":{"content":"An old talk about the cache layer."},"origin":{"kind":"human"}}'
} | mk old.jsonl
{
  line '{"type":"user","uuid":"h1","timestamp":"2026-10-01T12:00:00Z","sessionId":"judge","entrypoint":"sdk-cli","message":{"content":"Judge this ticket."}}'
} | mk judge.jsonl
U "touch -d '26 days ago' $PROJ/old.jsonl"

echo "== Stop captures the running session's transcript"
U "echo '{\"session_id\":\"live\",\"transcript_path\":\"'\$HOME'/.claude/projects/-home-alex-work/live.jsonl\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts Stop >/dev/null 2>&1"
check "the live session's dialogue is in the store" U "$T bin/cortex-memory.ts context search rabbitmq | grep -q 'Why not RabbitMQ'"
check "... the assistant's answer too, but never its thinking" U "$T bin/cortex-memory.ts context search ordering | grep -q 'append-only log' && ! $T bin/cortex-memory.ts context search private | grep -q private"
check "... and the pasted token never reached the store" U "$T -e \"import D from 'better-sqlite3'; const t = new D(process.env.HOME + '/.config/ckn/data/memory/context.sqlite').prepare('select group_concat(text) t from blocks').get().t; process.exit(t.includes('[redacted: provider-prefix]') && !t.includes('AKIA') ? 0 : 1)\""
check "status flags the old transcript as at risk of cleanup" U "$T bin/cortex-memory.ts capture --status | grep -q 'AT RISK.*old.jsonl'"

echo "== SessionStart: the warning, and the detached catch-up"
U "echo '{\"session_id\":\"next\",\"source\":\"startup\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts SessionStart > /tmp/start.out 2>&1"
check "the session is told a transcript is at risk" U "grep -q 'not yet captured' /tmp/start.out"
waitcheck "the catch-up captured the old transcript" 30 U "$T bin/cortex-memory.ts context search cache | grep -q 'old talk'"
waitcheck "status: nothing at risk, nothing behind" 30 U "$T bin/cortex-memory.ts capture --status | grep -q 'not yet captured 0'"
check "the headless run is skipped, not captured" U "$T bin/cortex-memory.ts capture --status | grep -q 'skipped (headless) 1' && ! $T bin/cortex-memory.ts context search judge | grep -q Judge"

echo "== a bus message between two sessions is dialogue"
U "$T bin/cortex-role.ts join lead --create --as lead-1 >/dev/null 2>&1; $T bin/cortex-role.ts join alpha-dev --create --as alpha-dev-1 >/dev/null 2>&1"
U "echo 'Use the log for the job queue; RabbitMQ is out.' > /tmp/b.txt && $T bin/cortex-role.ts send alpha-dev --as lead-1 --body-file /tmp/b.txt >/dev/null 2>&1"
check "comms wrote it to its dialogue feed" U "grep -q 'RabbitMQ is out' ~/.config/ckn/data/comms/dialogue/send.ndjson"
U "$T bin/cortex-memory.ts capture --all >/dev/null 2>&1"
check "capture took it in as dialogue from lead-1" U "$T bin/cortex-memory.ts context search 'rabbitmq out' | grep -q 'RabbitMQ is out'"
ID=$(U "$T bin/cortex-memory.ts context search 'rabbitmq queue' -n 20" | grep 'Why not RabbitMQ' | sed -E 's/^#([0-9]+).*/\1/' | head -1)
check "a window over the transcript question shows the lead's bus message beside it" U "$T bin/cortex-memory.ts context window $ID 5 | grep -q '\[bus\] lead-1'"
check "capture again adds nothing" U "$T bin/cortex-memory.ts capture --all | grep -q ', 0 parts added'"

echo "== anchors: the dialogue that produced a memory"
U "mkdir -p ~/.claude/memory && printf -- '---\nname: queue-choice\ndescription: The job queue is the append-only log, not RabbitMQ.\ntype: decision\n---\n\nUse the log for the job queue.\n' > ~/.claude/memory/queue-choice.md"
{
  line '{"type":"user","uuid":"l4",'"$TS"',"message":{"content":"Agreed, remember that we chose the log."},"origin":{"kind":"human"}}'
  line '{"type":"assistant","uuid":"l5","timestamp":"2026-10-01T12:00:05Z","message":{"id":"m5","content":[{"type":"tool_use","id":"tw1","name":"Write","input":{"file_path":"/home/alex/.claude/memory/queue-choice.md","content":"..."}}]}}'
} | mk live.jsonl
U "echo '{\"session_id\":\"live\",\"transcript_path\":\"'\$HOME'/.claude/projects/-home-alex-work/live.jsonl\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts Stop >/dev/null 2>&1"
U "$T bin/cortex-memory.ts sweep >/dev/null 2>&1"
check "context why shows the dialogue that produced the memory" U "$T bin/cortex-memory.ts context why queue-choice | grep -q 'Why not RabbitMQ'"
check "backfill finds nothing new once capture anchored it" U "$T bin/cortex-memory.ts capture --anchors | grep -q 'anchors backfilled: 0 new'"

echo
echo "capture sim: $pass passed, $fail failed"
cleanup
[ "$fail" -eq 0 ]
