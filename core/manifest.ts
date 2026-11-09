/**
 * The module manifest — the contract between core and a mod.
 *
 * `module.json` in a module directory is what makes it a module. Everything a
 * mod contributes is DECLARED here: core reads the manifest before any module
 * code is imported, so a malformed or incompatible mod is refused without ever
 * executing.
 *
 * Design decisions encoded here, with the reasoning that produced them:
 *
 *  - `subscribes`, not `hooks`. Core registers exactly ONE harness hook per
 *    lifecycle event and dispatches in-process. Mods never register hooks
 *    themselves. Consequence: installing a mod does not touch the user's
 *    settings.json at all.
 *  - `requires` / `optional` for mod-on-mod dependency. Discouraged by default,
 *    legal by design, always declared. `requires` absent ⇒ mod does not start.
 *    `optional` absent ⇒ mod starts with that feature disabled.
 *  - `storage` is an opt-in amenity. Omitting it means the mod needs no storage;
 *    `use: 'self'` means it brings its own and core opens nothing for it.
 *  - `ui` is defined HERE, in core, even though only the UX mod reads it. If the
 *    UX mod owned the format, every mod wanting UI would depend on the UX mod.
 */

import { z } from 'zod'

/** Kebab-case, filesystem- and URL-safe. Also the mod's namespace. */
const ModuleName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'must be lower-case kebab (e.g. "memory", "code-graph")')
  .max(64)

const SemverRange = z.string().min(1)

/** A capability id: `<module>.<capability>`, e.g. `memory.recall`. */
const CapabilityId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9]*$/, 'must be "<module>.<capability>"')

/**
 * Lifecycle events a mod may subscribe to. Deliberately an enum rather than a
 * free string: an unknown event is a typo that would otherwise fail silently
 * at runtime, and silence is the failure mode we are designing out.
 */
export const LIFECYCLE_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'Stop',
] as const
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number]

const Subscription = z.object({
  event: z.enum(LIFECYCLE_EVENTS),
  /** Module-relative path to the handler module. */
  handler: z.string().min(1),
  /**
   * Lower runs earlier. Explicit because ordering between mods on a shared
   * event must be deterministic and core-controlled, never incidental.
   */
  order: z.number().int().default(100),
  /**
   * For a `runs: host` module: register this handler in every process, not only the host. Its
   * start() has not run there, so the handler may use only its ctx (dataDir, capabilities).
   */
  outsideHost: z.boolean().default(false),
})

const Route = z.object({
  mount: z.string().regex(/^\/[a-z0-9\-/]*$/, 'must be a lower-case path like "/api/memory"'),
  handler: z.string().min(1),
})

/** A slash subcommand contributed under the core root namespace. */
const Command = z.object({
  sub: z.string().regex(/^[a-z][a-z0-9-]*$/),
  file: z.string().min(1),
  summary: z.string().min(1).max(200),
})

/** Core's own commands that a module may extend with extra arguments. */
export const CORE_COMMANDS = ['rename'] as const

/**
 * A module's extension of a core command (19 Oct 2026: comms adds `[role]` to
 * `/cortex-rename`). Core shows the argument form only while the module is
 * installed, and passes the extra arguments to subscribers in the command's
 * event, so no core command knows any module by name.
 */
const Extension = z.object({
  command: z.enum(CORE_COMMANDS),
  /** The argument form as shown, e.g. "[role]". */
  args: z.string().regex(/^\[[a-z][a-z0-9-]*\]$/, 'one optional argument, e.g. "[role]"'),
  summary: z.string().min(1).max(200),
})

const CoreStorage = z.object({
  use: z.literal('core'),
  /** Tables this mod OWNS. Core enforces cross-module collision. */
  tables: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
  /**
   * Read-only views over tables this mod may not own. Declaring a view over
   * another mod's tables is a READ dependency — list that mod in `optional`
   * so its absence degrades the view rather than breaking the mod.
   */
  views: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
})

const SelfStorage = z.object({
  use: z.literal('self'),
})

/**
 * The style-describer. Optional; a mod without it is headless, and a system
 * without a UX mod ignores it harmlessly. Both directions degrade to nothing.
 */
const Ui = z.object({
  navTitle: z.string().min(1).max(60),
  icon: z.string().min(1).max(60).optional(),
  pages: z
    .array(
      z.object({
        route: z.string().regex(/^\/[a-z0-9\-/]*$/),
        title: z.string().min(1).max(60),
        entry: z.string().min(1),
      }),
    )
    .default([]),
})

export const ManifestSchema = z
  .object({
    name: ModuleName,
    version: z.string().min(1),
    /** Core versions this mod works with. Core checks BOTH directions. */
    requiresCore: SemverRange,
    description: z.string().min(1).max(500).optional(),

    provides: z.array(CapabilityId).default([]),
    /** Hard mod dependencies. Absent ⇒ this mod does not start. */
    requires: z.array(ModuleName).default([]),
    /** Soft mod dependencies. Absent ⇒ mod starts, feature disabled. */
    optional: z.array(ModuleName).default([]),

    storage: z.discriminatedUnion('use', [CoreStorage, SelfStorage]).optional(),
    subscribes: z.array(Subscription).default([]),
    routes: z.array(Route).default([]),
    commands: z.array(Command).default([]),
    /**
     * A segment this module adds to core's status line: a shell script (module-relative) that reads
     * the status line JSON on stdin and prints its part. Plain shell, since the line renders on every
     * prompt. Linked in on install, unlinked when the module goes; lower `order` prints first.
     */
    statusline: z.object({ script: z.string().min(1), order: z.number().int().default(50) }).optional(),
    /**
     * What core's updater runs for this module around an update, as `cli` entries are written
     * ("core:bin/x.ts args" or a module-relative script): `before` once the new code is in and before
     * the install, `after` once it is installed. A failing step fails the update, which rolls back.
     */
    update: z.object({ before: z.string().min(1).optional(), after: z.string().min(1).optional() }).optional(),
    extends: z.array(Extension).default([]),
    /**
     * Files this module writes under ~/.claude/cortex/ for the user's CLAUDE.md to
     * import (@path), so their text loads natively in every session (E1, 20 Oct).
     * Core owns the import block; the module owns the file's content.
     */
    claudeImports: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*\.md$/)).default([]),
    /**
     * Scripts put on the user's PATH as managed shims named after the file (B.6, 21 Oct).
     * Module-relative, or `core:bin/...` for a module's CLI that lives in core's bin.
     */
    cli: z.array(z.string().regex(/^(core:)?bin\/cortex-[a-z0-9-]+\.ts$/)).default([]),
    ui: Ui.optional(),

    /** Env vars the mod reads. Missing ones are a warning, never fatal. */
    env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    /** Module-relative test files, run by core's test runner. */
    tests: z.array(z.string().min(1)).default([]),
    /**
     * Where start() may run. 'host': only in the long-running Cortex host
     * (core/index.ts), never in a hook or CLI process. Hook processes start
     * every module on every event, which must not start a poller or a listener.
     */
    runs: z.enum(['anywhere', 'host']).default('anywhere'),
    /**
     * This module records dialogue it carries (a person or another session speaking)
     * as a dialogue feed under its data dir (core/dialogue.ts). Readers find feeds
     * through this flag; the module never knows who reads them.
     */
    dialogue: z.boolean().default(false),
    /**
     * Background jobs the core scheduler runs (core/schedule.ts): every N hours,
     * optionally only when no session is active. The command is a module script
     * or `core:bin/...` with arguments.
     */
    schedule: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
          everyHours: z.number().positive(),
          command: z.array(z.string()).min(1),
          idle: z.boolean().default(true),
          timeoutMinutes: z.number().positive().default(60),
        }),
      )
      .default([]),
    /**
     * Mesh record kinds this module floods between machines, with their policy.
     * The mesh daemon reads them at start. `never` lists peer intents a kind is
     * kept from; left out, it is ['gateway'] (fail closed).
     */
    meshKinds: z
      .record(
        z.string().regex(/^[a-z][a-z0-9-]*$/),
        z.object({ ephemeral: z.boolean().optional(), never: z.array(z.string()).optional() }).strict(),
      )
      .default({}),
  })
  .strict()
  .superRefine((m, ctx) => {
    // A mod cannot depend on itself — trivially a cycle, and a resolver that
    // has to special-case it later is a resolver with a bug waiting.
    if (m.requires.includes(m.name) || m.optional.includes(m.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `module "${m.name}" depends on itself` })
    }
    // Same name in both lists is ambiguous: is it fatal-if-absent or not?
    const both = m.requires.filter((r) => m.optional.includes(r))
    if (both.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${both.join('", "')}" listed as both required and optional`,
      })
    }
    // Capability ids must be namespaced to the declaring module, or two mods
    // could claim the same id and the registry would silently pick one.
    const foreign = m.provides.filter((p) => !p.startsWith(`${m.name}.`))
    if (foreign.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `capabilities must be namespaced "${m.name}.*": got "${foreign.join('", "')}"`,
      })
    }
  })

export type Manifest = z.infer<typeof ManifestSchema>

export type ManifestResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: string[] }

/** Parse and validate. Never throws — a bad manifest is data, not an exception. */
export const parseManifest = (raw: unknown): ManifestResult => {
  const parsed = ManifestSchema.safeParse(raw)
  if (parsed.success) return { ok: true, manifest: parsed.data }
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => {
      const path = i.path.join('.')
      return path ? `${path}: ${i.message}` : i.message
    }),
  }
}
