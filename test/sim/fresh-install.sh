#!/usr/bin/env bash
# A stranger's install (public gate G7): a new user on a machine with no Cortex, following README
# and INSTALL only, with the public tree (no modules/linear). One throwaway container.
#
# Proves: install from the user's home on a one-user machine; comms, memory, private-mind, telegram
# and gateway installed; status healthy and core's commands and status line in place; local-only
# (no daemon, no open port); a session start, a memory written and recalled, a message sent and
# received; private mind, telegram and gateway installed but unconfigured, saying so, with no bot
# and no secrets; uninstall leaves the user's Claude config as it was.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$SRC/node_modules" ] && { echo "node_modules in $SRC is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
P=fresh-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
cleanup() { docker rm -fv $P >/dev/null 2>&1; }
cleanup; trap cleanup EXIT

docker run -d --init --name $P -v $SRC:/src:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null
Z() { docker exec $P bash -c "$1"; }
A() { docker exec $P runuser -l alex -c "cd ~/cortex; $1"; }
T='node_modules/.bin/tsx'

# Content sweep of the user's HOME (not the checkout, not npm's cache) for the private names and the
# author's rule phrasings: the private .public-loose list, kept outside the repo (CORTEX_PUBLIC_LISTS),
# so the list never enters the tree. Without it the sweep is skipped, and says so.
LOOSE=${CORTEX_PUBLIC_LISTS:-$SRC}/.public-loose
if [ -f "$LOOSE" ]; then grep -v '^#' "$LOOSE" | grep . | docker exec -i $P sh -c 'cat > /tmp/sweep.patterns'
else echo "  (no .public-loose: set CORTEX_PUBLIC_LISTS for the content sweep)"; docker exec $P sh -c ': > /tmp/sweep.patterns'; fi
sweep() {
  local what="nothing private or personal anywhere in HOME $1" hits
  [ -n "${2:-}" ] && { A "[ -s $2 ]" || { no "$what: $2 is empty"; return; }; what="$what, $2 included"; }
  hits=$(A 'cd ~ && find . -mindepth 1 -maxdepth 1 ! -name cortex ! -name .npm -print0 | xargs -0 grep -rioaF -f /tmp/sweep.patterns -- | sort -u')
  [ -z "$hits" ] && ok "$what" || { no "$what"; echo "$hits" | sed 's/^/    hit: /'; }
}

echo "== a new user gets the public tree"
Z 'useradd -m -s /bin/bash alex
   mkdir -p /home/alex/cortex && cd /src && git -c safe.directory=* ls-files -co --exclude-standard | awk "NR==FNR { if (\$0 !~ /^#/ && NF) x[++n]=\$0; next } { for (i=1;i<=n;i++) if (index(\$0, x[i])==1) next; print }" $(test -f .public-exclude && echo .public-exclude || { echo "\#" > /tmp/no-exclude; echo /tmp/no-exclude; }) - | tar -cf - -T - | tar -xf - -C /home/alex/cortex
   cp -a /src/node_modules /home/alex/cortex/ && chown -R alex /home/alex/cortex
   runuser -l alex -c "mkdir -p ~/.claude && printf %s \"{\\\"theme\\\":\\\"dark\\\"}\" > ~/.claude/settings.json"'
before=$(A 'node -e "console.log(JSON.stringify(require(process.env.HOME + \"/.claude/settings.json\")))"')
check "the tree has no linear module" A '! ls modules/linear'
check "the tree carries none of the private lists" A '! ls .public-names .public-loose .public-exclude 2>/dev/null | grep -q .'

echo "== install, as README says"
# What HOME holds before Cortex, so the manifest below lists only what the install created.
A 'cd ~ && find . \( -path ./cortex -o -path ./.npm \) -prune -o \( -type f -o -type l \) -print | sort > /tmp/home.before'
# The image has a second account (node) that does not run Cortex: no reason to refuse.
A "$T bin/cortex-install.ts > /tmp/install.out 2>&1; echo \$? > /tmp/install.rc"
check "install succeeds from the user's home (another account exists, but does not run Cortex)" A '[ "$(cat /tmp/install.rc)" = 0 ]'
A 'cat /tmp/install.out' | sed 's/^/    /' | head -30
check "comms, gateway, memory, private-mind and telegram are installed" A '[ "$(ls ~/.config/ckn/modules | tr "\n" " ")" = "comms gateway memory private-mind telegram " ]'
check "cortex-status: healthy, nothing blocked or failed" A "$T bin/cortex-status.ts | grep -q 'healthy' && ! $T bin/cortex-status.ts | grep -qiE 'blocked|failed'"
check "core's commands are in place (status, statusline, update, rename)" A 'for c in status statusline update rename; do [ -f ~/.claude/commands/cortex-$c.md ] || exit 1; done'
check "the hooks are in the user's settings" A 'grep -q cortex-hook.ts ~/.claude/settings.json'
check "the status line segments of memory and comms are linked" A '[ "$(ls ~/.config/ckn/statusline.d | tr "\n" " ")" = "10-memory.sh 20-comms.sh " ]'
check "the status line renders" A 'echo "{\"session_id\":\"s1\"}" | bash bin/cortex-statusline.sh | grep -q "cortex"'
sweep "after the install"

echo "== local-only by default"
check "no mesh daemon" A "! pgrep -f '[c]ortex-mesh.ts serve'"
check "no port open" Z "! grep -q ':0BCD 00000000:0000 0A' /proc/net/tcp"
A "$T bin/cortex-mesh.ts status" | grep connect | sed 's/^/    /'
check "the node is set not to listen, with no peers" A "$T bin/cortex-mesh.ts status | grep connect | grep -q 'does not listen.*0 peer(s).*local-only'"

echo "== a session"
# The injection goes to a file in HOME so the content sweep reads exactly what the hook told the session.
check "a session start answers" A "echo '{\"session_id\":\"s1\",\"hook_event_name\":\"SessionStart\"}' | CLAUDE_CODE_ENTRYPOINT=cli $T bin/cortex-hook.ts SessionStart > ~/session-start.out"
echo "    injected at session start:"; A 'cat ~/session-start.out; echo' | sed 's/^/      /'
# The session start leaves a transcript catch-up and the scheduler running detached; they write
# files too (schedule.json), so wait for them before listing.
check "the session start's detached work finishes" A 'for i in $(seq 60); do pgrep -u alex -f "bin/cortex-(memory|schedule)\.ts" >/dev/null || exit 0; sleep 0.5; done; exit 1'

echo "== what the install created (test/sim/fresh-install.manifest)"
# Names are normalised (timestamps and ids become placeholders, sqlite sidecars fold into their
# database, which come and go with the connection); contents are never compared.
got=$(A 'cd ~ && find . \( -path ./cortex -o -path ./.npm \) -prune -o \( -type f -o -type l \) -print | sort | comm -13 /tmp/home.before - \
     | grep -vx ./session-start.out' | sed -E 's|^\./||
       s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}[-:][0-9]{2}[-:][0-9]{2}([-.][0-9]{3})?Z/<ts>/g
       s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g
       s/-(wal|shm|journal)$//' | sort -u)
want=$(grep -v '^#' "$SRC/test/sim/fresh-install.manifest" 2>/dev/null | grep . | sort -u)
extra=$(comm -23 <(echo "$got") <(echo "$want")); missing=$(comm -13 <(echo "$got") <(echo "$want"))
[ -n "$got" ] && [ -z "$extra" ] && [ -z "$missing" ] && ok "every file the install created is in the manifest, and every manifest file was created ($(echo "$got" | wc -l) paths)" || {
  no "every file the install created is in the manifest, and every manifest file was created"
  [ -n "$extra" ] && echo "$extra" | sed 's/^/    not in the manifest: /'
  [ -n "$missing" ] && echo "$missing" | sed 's/^/    in the manifest, not created: /'; }

echo "== the store starts empty"
A "$T bin/cortex-memory.ts status" | sed 's/^/    /'
check "no rows in the memories table" A "[ \"\$(node -e \"const D=require('better-sqlite3'); console.log(new D(process.env.HOME+'/.config/ckn/cortex.sqlite',{readonly:true}).prepare('select count(*) n from memories').get().n)\")\" = 0 ]"
check "no standing rules" A "$T bin/cortex-rules.ts list | grep -q '^no rules yet'"
check "the memory journal has no records" A '! find ~/.config/ckn/data/memory/journal -name "*.ndjson" -size +0 2>/dev/null | grep -q .'
check "no memory files under ~/.claude/memory or ~/.claude/projects/*/memory" A '! find ~/.claude/memory ~/.claude/projects/*/memory -name "*.md" 2>/dev/null | grep -q .'
block=$(A "sed -n '/<!-- cortex:managed:imports/,/<!-- \/cortex:managed:imports -->/p' ~/.claude/CLAUDE.md")
echo "$block" | sed 's/^/    CLAUDE.md: /'
check "the Cortex block in CLAUDE.md is only @-imports between its markers, none preserved-" bash -c '
  b=$1; [ "$(echo "$b" | head -1 | grep -c "^<!-- cortex:managed:imports")" = 1 ] && [ "$(echo "$b" | tail -1)" = "<!-- /cortex:managed:imports -->" ] \
  && ! echo "$b" | sed "1d;\$d" | grep -qv "^@" && ! echo "$b" | grep -q "preserved-"' _ "$block"

sweep "after the session start" '~/session-start.out'

echo "== memory and messages"
check "a memory is written and recalled" A "mkdir -p ~/.claude/memory && printf -- '---\nname: harbour-cranes\ndescription: harbour crane count\ntype: decision\n---\n\nThe harbour has 4 cranes.\n' > ~/.claude/memory/harbour-cranes.md && $T bin/cortex-memory.ts sweep >/dev/null 2>&1 && $T bin/cortex-memory.ts recall harbour crane count | grep -q harbour-cranes"
check "a message goes and arrives, with no daemon" A "$T bin/cortex-role.ts join ops --create --as ops-1 >/dev/null && $T bin/cortex-role.ts join dev --create --as dev-1 >/dev/null && $T bin/cortex-role.ts send dev 'hello' --as ops-1 >/dev/null && $T bin/cortex-role.ts inbox --as dev-1 --all | grep -q hello"

echo "== the rest installed, unconfigured, and saying so"
check "private mind: not configured, so it does nothing" A "$T modules/private-mind/bin/cortex-mind.ts status | grep -qi 'not configured\|no mind.json\|NOT enabled' || [ ! -f ~/.config/ckn/data/private-mind/mind.json ]"
check "telegram: no built-in bot, no secrets" A "[ ! -f ~/.config/ckn/data/telegram/telegram.json ] && ! grep -rqiE 'bot[0-9]{6,}:|api\.telegram\.org/bot[0-9]' modules/telegram/server"
check "gateway: not configured" A "[ ! -f ~/.config/ckn/data/gateway/gateway.json ]"

echo "== uninstall"
A "$T bin/cortex-install.ts uninstall >/dev/null 2>&1"
after=$(A 'node -e "console.log(JSON.stringify(require(process.env.HOME + \"/.claude/settings.json\")))"')
[ "$after" = "$before" ] && ok "the user's Claude settings say what they said before" || { no "the user's Claude settings say what they said before"; echo "    before: $before"; echo "    after:  $after"; }
check "no Cortex command is left" A '! ls ~/.claude/commands/cortex-* 2>/dev/null | grep -q .'

echo; echo "fresh install sim: $pass passed, $fail failed"
[ $fail -eq 0 ]
