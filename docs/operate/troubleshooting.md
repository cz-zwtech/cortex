---
name: cortex-troubleshooting
description: "Common failure modes and their fixes"
audience: operator
---

# Troubleshooting

**Hooks aren't firing**

Check `~/.claude/settings.json` `hooks` block — every Cortex hook has a marker (`ckn-sync`, `ckn-recall`, etc.). If they're missing, `npm start` reinstalls.

**Server won't start**

Most likely a stale `tsx watch` process holding port 3001. Run `ckn-stop`, then `ckn-start`. Kill by explicit PID, not a broad `pkill -f tsx` — a `pkill -f`/`pgrep -f` matching the `tsx watch server/index.ts` pattern self-matches the shell you run it from. `tsx watch` also does **not** reload on `/mnt` under WSL (inotify is unreliable on DrvFs) — after editing `server/*` you must actually restart, not rely on watch.

**Server says "ready" but requests hang (`curl` returns 000)**

The single event loop is blocked. `ss -ltn | grep :3001` showing a climbing Recv-Q confirms it. This used to be embedding inference on the main thread — now fixed (inference runs in a worker thread), so `local` embeddings are safe. If it still happens it's usually a heavy write-lock operation at startup (the private-mind re-index over a large corpus, or a big sync) and is transient — wait for the startup-sync log line rather than restarting repeatedly.

**Killing the server leaves port 3001 bound briefly**

Shutdown is now a trivial synchronous `wal_checkpoint(TRUNCATE)` + `close()` — there's no native fsync thread to get parked in uninterruptible `Dl` state at exit, so the old ~30–60s D-state wedge on the SQLite backend is gone. If the port still shows `LISTEN`ing momentarily after a kill, wait for it to free (`until ! ss -ltn | grep -q :3001; do sleep 2; done`) before starting a new server — don't spawn a second one on the same port.

**`/cortex-sync-shared` reports `no remote configured`**

Open the Shared Mind dialog, set the remote URL, then run `/cortex-sync-shared` again. Or via API: `curl -sX POST -H 'content-type: application/json' -d '{"url":"git@..."}' http://localhost:3001/api/shared/remote`.

**Graph is empty**

Run a Stop hook manually: `tsx ~/cortex/bin/ckn-sync.ts`. This re-imports every memory file. The database file is at `~/.config/ckn/graph.sqlite` — safe to delete and rebuild.

**Pattern detection is making noise**

Patterns auto-generate from every fail→success in your session JSONLs. To clear them: open the Graph view, filter by kind `pattern`, or just `rm ~/.config/ckn/graph.sqlite && tsx ~/cortex/bin/ckn-sync.ts`.


Related: [[cortex-running]] · [[cortex-updating]]
