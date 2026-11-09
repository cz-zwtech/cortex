# Writing a Cortex module

A Cortex module is a directory with a `module.json` in it. Drop it into the modules
directory, restart, it is live. That is the whole installation story.

This guide is written alongside the contract rather than after it, which means it doubles as
a design review: anything that cannot be explained simply here is probably wrong in the
contract. Where that happened, it is marked **[design note]** — those are honest admissions,
not documentation of intent.

---

## 1. The smallest module that works

```
my-module/
  module.json
  server/
    index.ts
```

```jsonc
// module.json
{
  "name": "my-module",
  "version": "1.0.0",
  "requiresCore": ">=2.0.0 <3.0.0"
}
```

```ts
// server/index.ts
import type { CortexModule } from 'cortex-core'

export default {
  start(ctx) {
    ctx.log('hello')
  },
} satisfies CortexModule
```

That is a complete, valid module. It uses no database, contributes no routes, registers no
hooks. `start` is optional — a module that only contributes routes needs no code at all
beyond the route handlers.

**The directory name must match `name` in the manifest.** Otherwise `status`, uninstall, and
the modules directory would disagree about what is installed.

---

## 2. What core gives you: `ctx`

`ctx` is the only way a module reaches core. There is no importing of core internals.

| Field | What it is |
|---|---|
| `ctx.name` | your module's name — do not hardcode your own identity |
| `ctx.dir` | absolute path to your module directory |
| `ctx.events` | the message bus |
| `ctx.capabilities` | other modules' capabilities (see §5) |
| `ctx.core` | `{ version, contract }` so you can adapt rather than guess |
| `ctx.log` | prefixed logging |
| `ctx.db` | the shared database — **only if you asked for it** (§4) |
| `ctx.dataDir` | your private data directory — only if you declared `storage: self` |

### Core services are offered, not required

The database and the event bus are **amenities**. They cost nothing when unused, they exist
to make module authoring cheap, and you may decline any of them. A module that uses none is
completely valid.

`ctx.db` is typed as possibly-undefined on purpose. If you did not ask for storage, the
compiler makes you handle its absence — the guarantee is enforced, not promised.

---

## 3. Lifecycle: subscribe, do not hook

Cortex runs inside a harness that fires lifecycle events (`SessionStart`, `SessionEnd`, and
so on). **Your module does not register harness hooks.** Core registers exactly one hook per
event and dispatches to subscribers in process.

```jsonc
"subscribes": [
  { "event": "SessionEnd", "handler": "./server/onSessionEnd.js", "order": 50 }
]
```

```ts
// server/onSessionEnd.ts
export default async (payload: unknown) => {
  // do your work; return anything, or nothing
}
```

`order` is explicit and lower runs earlier. Ordering between modules on a shared event has to
be deterministic and core-controlled, never incidental.

**Why this matters to you as an author:** installing your module does not modify the user's
harness settings at all. The hook registrations are static and written once. You cannot
corrupt them, and you cannot be blamed for another module's timeout — core owns the budget,
and a slow subscriber gets time-boxed and reported rather than taking the event down with it.

If your handler throws, the failure is recorded against your module and the other subscribers
still run.

---

## 3b. You own the information density of your contribution

**Core allocates budget. It cannot curate content.**

When your subscriber returns `additionalContext`, core merges it with every other module's
contribution up to a byte budget, in declared priority order. If the total overruns, whole
contributions are dropped — never cut mid-text, because half a memory reads as complete and
the consumer cannot tell.

**The obligation this creates:** a contribution must be internally deduplicated *before you
offer it*.

Here is the failure it prevents, which is not obvious and was found by holding two designs
together rather than in either one alone. Suppose your module returns several near-identical
items — five variants of one fact, five near-duplicate blast-radius entries, three
overlapping directives. Near-identical text produces near-identical embeddings, so relevance
ranking surfaces them **as a block**: they rank *together*, not low. You have now spent
several injection slots saying one thing — and core, having only bytes to go on, truncates
**someone else's module** to make room for your redundancy.

That is a cross-module fairness problem, not a quality problem. The evicted module did
nothing wrong, its author has no way to discover the cause, and the human silently receives
an incomplete injection.

**Core cannot fix this and must not try.** Knowing what two blocks of text *mean* is your
domain. A scaffold that starts semantically deduplicating module output has absorbed every
module's domain knowledge, which is the opposite of a scaffold.

**What core does instead is report the pressure.** Truncation is surfaced with the module
name, the size of what was dropped, and how much budget was left — so an author learns their
contribution is evicting others, and a human learns their injection was incomplete. Silence
would leave both blind.

**This is a testable contract obligation, not advice.** An obligation nothing enforces is
decoration — the same defect as a manifest field with no runner behind it. Your module's
tests should hand your contributor a corpus containing planted near-duplicates and assert
that the emitted block collapsed them.

```ts
test('contribution collapses near-duplicates before offering them', async () => {
  const corpus = [
    'The build fails when NODE_ENV is unset.',
    'Build fails if NODE_ENV is not set.',      // near-duplicate
    'Prefer pnpm over npm in this repo.',
  ]
  const block = await contribute(corpus)
  assert.equal(occurrences(block, /NODE_ENV/g), 1, 'one fact, one slot')
})
```

## 4. Storage

Three choices. Pick by what you actually need.

```jsonc
// (a) use the shared database — the common case
"storage": { "use": "core", "tables": ["my_things"], "views": [] }

// (b) bring your own store
"storage": { "use": "self" }

// (c) omit the field entirely — you need no storage
```

**You must declare the tables you own.** Core refuses to start a module that claims a table
another module already owns, and it refuses at registration — before either module's code
runs. This exists because the single worst structural defect in Cortex V1 was one table with
two owners, discovered years later. Making that impossible is cheap here.

### Reading another module's data

Do not write to tables you do not own; there is no supported way to do it. To *read* across a
boundary, declare a **view**:

```jsonc
"storage": { "use": "core", "tables": ["my_things"], "views": ["my_summary"] },
"optional": ["memory"]
```

A view over another module's tables is a read dependency. List that module in `optional` so
its absence degrades your view rather than breaking your module.

With `use: "self"` you get `ctx.dataDir` and **you own your own write discipline** — core's
single-writer protection covers the shared database only. This is the sharp edge of declining
an amenity, and it is on you.

---

## 5. Depending on other modules

The default is: don't. Modules that stand alone are easier to install, test, and reason
about. But dependency is legal, because a module that extends another module is real
evolution and the contract should not forbid it.

```jsonc
"requires": ["memory"],     // hard: you do not start without it
"optional": ["comms"]       // soft: you start, that feature is disabled
```

| | Provider absent |
|---|---|
| `requires` | your module **does not start**; `status` says why; the rest of the system is unaffected |
| `optional` | your module starts, **that feature is off** — never an error |

Core resolves dependencies into a start order, so a dependency is always up before you are.
Cycles are detected and refused by name. Requiring a module that cannot itself start blocks
you too, transitively.

### Consuming a capability

```ts
const recall = ctx.capabilities.get<RecallFn>('memory.recall')
if (recall) {
  const hits = await recall({ query, limit: 8 })
}
// no else needed — the feature is simply absent
```

`get()` returns `undefined` when the provider is absent. **There is deliberately no throwing
variant**, because an optional dependency must be checkable without exception handling.

### Providing a capability

```jsonc
"provides": ["my-module.doThing"]
```

```ts
ctx.capabilities.provide('my-module.doThing', (arg: string) => { /* ... */ })
```

Capability ids must be namespaced to your module — core rejects a manifest that claims
otherwise, or two modules could claim the same id and the registry would silently pick one.

**If another module extends yours, your capabilities are a public API.** Semver applies to
them exactly as it applies to core's contract. Renaming a capability is a breaking change.

> **[design note]** The guide can explain what a capability *is*, but not yet how you
> discover what shape one has. `memory.recall` returning `unknown` puts the burden on
> documentation and good faith. A capability **type registry** — or at minimum a convention
> that providers ship their types — is a real gap in the contract that writing this section
> exposed. Filed rather than papered over.

---

## 6. Contributing surface

### Routes
```jsonc
"routes": [{ "mount": "/api/my-module", "handler": "./server/routes.js" }]
```
Export an Express router as default. Core mounts module routes **after** its own, so a module
cannot shadow `/api/health` and make a broken system look healthy.

### Commands
```jsonc
"commands": [{ "sub": "things", "file": "commands/things.md", "summary": "List things" }]
```
Your command appears under the core namespace rather than as a top-level name. Core generates
the root help from installed contributions, so nothing is hand-maintained.

### Extending a core command
```jsonc
"extends": [{ "command": "rename", "args": "[role]", "summary": "also join this role under the new name" }]
```
Core owns `/cortex-rename`; it works with no module installed. A module may add one optional
argument to it. The installed command text shows the argument form only while your module is
installed, core refuses extra arguments no installed module declared, and your module receives
them in the command's event (`session.renamed`, payload `args`). Subscribe with
`ctx.events.subscribe('session.renamed', ctx.name, handler)` and return `{ lines: string[] }` to
tell the person who renamed what you did. The same event fires when the user renames the
session with Claude Code's own `/rename`, with `source: 'harness'`.

### UI
```jsonc
"ui": {
  "navTitle": "My Module",
  "icon": "box",
  "pages": [{ "route": "/my-module", "title": "Things", "entry": "ui/ThingsView.js" }]
}
```
Optional. A module without `ui` is headless; a system without a UX module ignores `ui`
harmlessly. Both directions degrade to nothing.

Note this block is defined by **core**, not by the UX module — otherwise every module wanting
a UI would depend on the UX module, which is exactly the coupling the contract avoids.

---

## 7. Versioning

You declare which cores you work with; core declares which modules it hosts. **Both
directions are checked**, and either side may refuse.

```jsonc
"requiresCore": ">=2.0.0 <3.0.0"
```

A refused module does not start, `status` says why, and the rest of the system is unaffected.
An incompatible module is never a crash.

Core's **contract version** is separate from its **build version**. Core can ship bugfixes
without moving the contract, so you are not forced to re-release every time core changes.
Breaking changes are published in a machine-readable list keyed by contract version — you
should never have to discover one by having your module break.

---

## 8. Testing

```jsonc
"tests": ["test/my-module.test.ts"]
```

Declare your tests and core runs them. Write against your **public surface** — your routes,
your capabilities, your subscribers — not against core internals or another module's tables.

The test that matters most: **your module with its optional dependencies absent.** That is
the path that rots silently, because it works fine on the developer's machine where
everything is installed. If you declare `optional`, test the absent case or the guarantee is
decorative.

> **[design note]** `tests` is declared in the manifest but the runner that consumes it is
> not built yet — it is a Phase 2 deliverable that landed as a contract field ahead of its
> implementation. Declaring it now is deliberate (so the field is not a breaking addition
> later), but authors should know it currently does nothing.

---

## 9. What core will refuse, and when

Everything that can refuse a module happens **before your code is imported**:

| Stage | Refuses |
|---|---|
| discover | unreadable or malformed `module.json`; name/directory mismatch |
| validate | schema violations; version incompatibility; missing hard deps; cycles |
| register | table or view collisions |
| start | *(your code finally runs)* |

So a module refused for any of the first three reasons has **never executed**. If your module
appears as `failed` rather than `blocked`, that means it started and threw — the distinction
is diagnostic, and worth knowing when reading `status`.

A module that fails at start is isolated: its subscriptions, capabilities and table claims are
released, and the rest of the system carries on.

---

## 10. Checklist

**Naming (18 Oct 2026, standing rule).** A module stands on its own in Cortex.
- Its name, folder, CLIs (`cortex-<name>`), capabilities, events, roles and data dir carry no `zw`
  prefix and no machine, client or brand name.
- Name it for what it specifically is (`telegram`, not `notify`).
- Module code has no machine-specific defaults (`node-a`, `node-b`, `node-a-svc`): those go in config or env.
- Real node names in doc examples are fine, and so are secret key names that config refers to.
- `test/moduleNaming.test.ts` enforces this for every module in the repo.


- [ ] Directory name matches `name`
- [ ] `requiresCore` is an honest range, not `*`
- [ ] Tables you own are declared; you write to no others
- [ ] Optional dependencies are actually optional — tested with the provider absent
- [ ] Capabilities namespaced to your module
- [ ] Subscriber handlers are cheap; core owns the budget but do not spend it carelessly
- [ ] Your module works with the UX module absent

---

## 11. Prefer the version that cannot be built wrong

The rule that produced more correct code than any other on this project:

> **Prefer the version that CANNOT BE BUILT WRONG over the version that is
> DOCUMENTED as wrong-if-built-that-way.**

Three fixes in one week took this shape, and in each the documented alternative would have
worked, passed review, and left the class open:

| Documented fix | Structural fix |
|---|---|
| "the guarantee is not claimable until the archive gains a removal path" — a *conditional*, satisfied by patching one instance | **every content-bearing surface must be re-derivable** — an *invariant*, which makes the whole class unconstructable |
| add a newline after the decline marker so the next fence still starts a block | **strip markers before dividing the file** — a record ABOUT content must not help decide WHAT the content is |
| a comment saying "re-derive the thresholds if you swap the estimator" | **thresholds live on the estimator** — swapping it necessarily swaps its calibration |

**The test for which shape you need:** ask what happens when the rule is broken.

If breaking it produces a **failure**, a document is often enough — the failure teaches the
next person. If breaking it produces **silence**, a document is not enough, because nothing
will ever prompt anyone to read it. The threshold case is the pure form: carrying Jaccard's
floors onto cosine still compiles, still passes every test, and degrades recall in a direction
nobody is measuring. **A failure mode that never fails a test cannot be governed by a note.**

Applied to writing a module:

- If your capability can be called in an order that corrupts state, **make the wrong order
  unrepresentable** (take a token that only the correct predecessor can mint) rather than
  documenting the order.
- If two values must stay consistent, **make them one value**.
- If a caller must not skip a step, **make the step's output the next step's input**.
- Where you genuinely cannot close it structurally, say so where the caller looks — in the
  **type**, not in prose. `provisional: true` on a field beats a paragraph nobody opens.
