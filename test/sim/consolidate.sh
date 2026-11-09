#!/usr/bin/env bash
# Consolidation in a throwaway container (private mind steps 4a and 4b). A fake
# `claude` on PATH answers like the model would, so no model is called and no
# real memory is touched: the memories are made up.
#
# Proves: consolidate gives facets through the CLI, recorded per run; a query
# by concern finds memories through their facets; a contradiction flags the
# older memory and a passed end date flags its memory, neither removed; a
# finished, cold stretch of dialogue gets a searchable digest; a run
# reverts whole; the scheduler runs the nightly job as the module declares it.
set -u
SRC=${R:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -L "$SRC/node_modules" ] && { echo "node_modules in $SRC is a symlink: the sim mounts the checkout into a container, where the link target does not exist. Run npm ci in the checkout." >&2; exit 2; }
GITDIR=$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir)
# One run of this sim at a time on a host (some use fixed subnets); names carry a run id besides.
LOCK=/tmp/cortex-sim-consolidatesim.lock; exec 9>>"$LOCK"; chmod 666 "$LOCK" 2>/dev/null; flock 9
P=consolidatesim-${RUN_ID:-$$}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
cleanup() { docker rm -fv $P >/dev/null 2>&1; }
cleanup

docker run -d --init --name $P -v $SRC:/src:ro -v $GITDIR:$GITDIR:ro --entrypoint sleep cortex-lab:dev infinity >/dev/null
Z() { docker exec $P bash -c "$1"; }
U() { docker exec $P runuser -l alex -c "cd /opt/cortex; export PATH=\$HOME/fakebin:\$PATH; $1"; }
T='node_modules/.bin/tsx'

echo "== setup: one user, made-up memories, a fake model"
Z 'useradd -m -s /bin/bash alex
   mkdir -p /opt/cortex && cd /src && git -c safe.directory=* ls-files -co --exclude-standard | tar -cf - -T - | tar -xf - -C /opt/cortex
   cp -a /src/node_modules /opt/cortex/ && chown -R alex /opt/cortex'
U "$T bin/cortex-install.ts --single-user --no-mesh-start >/tmp/install.out 2>&1"
U 'mkdir -p ~/.claude/memory ~/fakebin
for m in "queue-choice|The job queue is the append-only log, not RabbitMQ." "queue-rabbit|The job queue runs on RabbitMQ." "webhook-retries|Webhooks retry with exponential backoff and jitter." "cache-ttl|Cache entries live for five minutes." "deploy-freeze|Deploy freeze holds until 2026-01-15."; do
  n=${m%%|*}; b=${m#*|}; printf -- "---\nname: %s\ndescription: %s\ntype: decision\n---\n\n%s\n" "$n" "$b" "$b" > ~/.claude/memory/$n.md
done'
docker exec -i $P runuser -l alex -c 'cat > ~/fakebin/claude && chmod +x ~/fakebin/claude' <<'FAKE'
#!/usr/bin/env node
// Stands in for `claude -p --output-format json`, answering each consolidation stage as the model would.
let input = ''
const reply = (r) => console.log(JSON.stringify({ result: JSON.stringify(r), usage: { input_tokens: 900, output_tokens: 120 }, total_cost_usd: 0.0012 }))
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  if (input.includes('Memories: ')) {
    const items = JSON.parse(input.slice(input.indexOf('Memories: ') + 10))
    const f = { 'queue-choice': ['concern', 'inter-service-communication', 'billing-api'], 'queue-rabbit': ['concern', 'inter-service-communication', 'billing-api'], 'webhook-retries': ['concern', 'inter-service-communication', 'payments'], 'cache-ttl': ['concern', 'caching', 'billing-api'] }
    const memories = items.map((i) => { const [t, term, work] = f[i.name] ?? ['subject', 'misc', 'misc']; return { id: i.id, focus: { type: t, term }, about: [{ type: 'work', term: work }] } })
    return reply({ memories, spine: [{ child: 'billing-api', parent: 'payments' }] })
  }
  if (input.includes('Pairs: ')) {
    const pairs = JSON.parse(input.slice(input.indexOf('Pairs: ') + 7))
    return reply({ pairs: pairs.map((p) => [p.a.name, p.b.name].sort().join() === 'queue-choice,queue-rabbit'
      ? { pair: p.pair, relation: 'contradicts', newer: p.a.name === 'queue-choice' ? 'a' : 'b', why: 'moved off RabbitMQ' }
      : { pair: p.pair, relation: 'related', why: 'same area' }) })
  }
  if (input.includes('facet vocabulary')) return reply({ merge: [] })
  if (input.includes('Stretches: ')) {
    const spans = JSON.parse(input.slice(input.indexOf('Stretches: ') + 11))
    return reply({ digests: spans.map((s) => ({ span: s.span, keywords: ['rabbitmq', 'queue-decision'], facets: ['concern:inter-service-communication'], summary: 'Weighed RabbitMQ against the append-only log for the job queue.' })) })
  }
  reply({ lesson: null })
})
FAKE
U "$T bin/cortex-memory.ts sweep >/dev/null 2>&1"
# A finished conversation from August: cold by now, so it is digested.
U 'mkdir -p ~/.claude/projects/-home-alex-work && for i in 1 2 3 4 5 6; do
  if [ $((i % 2)) = 1 ]; then echo "{\"type\":\"user\",\"uuid\":\"o$i\",\"timestamp\":\"2026-08-01T09:0$i:00Z\",\"sessionId\":\"old\",\"entrypoint\":\"cli\",\"message\":{\"content\":\"Old question $i about the job queue.\"},\"origin\":{\"kind\":\"human\"}}"
  else echo "{\"type\":\"assistant\",\"uuid\":\"o$i\",\"timestamp\":\"2026-08-01T09:0$i:30Z\",\"message\":{\"id\":\"om$i\",\"content\":[{\"type\":\"text\",\"text\":\"Old answer $i on queues.\"}]}}"; fi
done > ~/.claude/projects/-home-alex-work/old.jsonl'
U "$T bin/cortex-memory.ts capture --file ~/.claude/projects/-home-alex-work/old.jsonl >/dev/null 2>&1"

echo "== consolidate"
check "before: a query by concern finds nothing" U "! $T bin/cortex-memory.ts recall inter-service communication | grep -q queue-choice"
check "consolidate applies facets for every memory, then relations" U "$T bin/cortex-memory.ts consolidate | grep -q 'done; .*(facets [0-9]*, relations [0-9]*.* 0 memories still without facets'"
check "the memory carries its focus facet" U "$T bin/cortex-memory.ts facets queue-choice | grep -q '\*concern:inter-service-communication'"
check "the vocabulary shows the spine" U "$T bin/cortex-memory.ts facets | grep -q 'work:billing-api  (part of payments)'"
check "a query by concern now finds both memories filed under it" U "o=\$($T bin/cortex-memory.ts recall inter-service communication); echo \"\$o\" | grep -q queue-choice && echo \"\$o\" | grep -q webhook-retries"
check "the run is recorded with tokens and cost" U "$T bin/cortex-memory.ts consolidate --runs | grep -q 'facets,relations,vocabulary,staleness,lessons,digests haiku  done: .* 4080 tokens'"
check "the contradicted, older memory is flagged" U "$T bin/cortex-memory.ts stale | grep -q 'contradicted .*queue-rabbit'"
check "the newer one is not" U "! $T bin/cortex-memory.ts stale queue-choice | grep -q contradicted"
check "a passed end date is flagged" U "$T bin/cortex-memory.ts stale | grep -q 'condition-lapsed .*deploy-freeze'"
check "flagged memories are kept and still recalled" U "$T bin/cortex-memory.ts recall RabbitMQ | grep -q queue-rabbit"
check "the cold conversation has a digest, found by search" U "$T bin/cortex-memory.ts context search queue-decision | grep -q '^digest .*:old:1: Weighed RabbitMQ'"
RUN=$(U "$T bin/cortex-memory.ts consolidate --runs" | awk '{print $1}' | head -1)
check "a run reverts whole" U "$T bin/cortex-memory.ts consolidate --revert $RUN | grep -q 'edges and' && $T bin/cortex-memory.ts facets queue-choice | grep -q 'no facets yet'"
check "and its flags go with it" U "$T bin/cortex-memory.ts stale | grep -q 'nothing flagged stale'"
check "and its digest" U "! $T bin/cortex-memory.ts context search queue-decision | grep -q '^digest'"

echo "== the scheduler runs the nightly job"
check "the memory module declares it" U "$T bin/cortex-schedule.ts status | grep -q 'memory/consolidate  every 24 h, idle only'"
check "scheduled runs are off until enabled" U "$T bin/cortex-schedule.ts run-due --force | grep -q 'scheduled consolidation is off on this machine'"
check "--enable turns them on with a model" U "$T bin/cortex-memory.ts consolidate --enable --model haiku | grep -q 'ON here: nightly, model haiku'"
U "rm -f ~/.config/ckn/data/schedule.json"
check "run-due runs it (forced past the idle check)" U "$T bin/cortex-schedule.ts run-due --force | grep -q 'memory/consolidate: ok'"
check "and the facets are back" U "$T bin/cortex-memory.ts facets queue-choice | grep -q 'concern:inter-service-communication'"
check "not due again until tomorrow" U "! $T bin/cortex-schedule.ts run-due | grep -q 'memory/consolidate: ok'"

echo
echo "consolidate sim: $pass passed, $fail failed"
cleanup
[ "$fail" -eq 0 ]
