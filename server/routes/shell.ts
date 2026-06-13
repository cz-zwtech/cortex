import { Router } from 'express'
import { spawn } from 'node:child_process'

export const shellRouter = Router()

// POST /api/shell/run  { cmd, args, cwd, timeoutMs }
// One-shot command execution — for scripted ops (claude CLI, git, etc.)
// For interactive sessions use the PTY WebSocket instead.
shellRouter.post('/run', async (req, res) => {
  const { cmd, args = [], cwd, timeoutMs = 30_000 } = req.body
  if (!cmd) return res.status(400).json({ error: 'cmd required' })

  // Allowlist: only permit known safe commands to prevent arbitrary execution
  const ALLOWED = new Set(['claude', 'git', 'node', 'npm', 'npx', 'which', 'ls'])
  const base = cmd.split('/').pop() ?? cmd
  if (!ALLOWED.has(base)) {
    return res.status(403).json({ error: `command '${base}' not in allowlist` })
  }

  const stdout: string[] = []
  const stderr: string[] = []

  const proc = spawn(cmd, args, {
    cwd: cwd ?? process.env.HOME,
    env: process.env,
    shell: false,
  })

  proc.stdout.on('data', (d) => stdout.push(d.toString()))
  proc.stderr.on('data', (d) => stderr.push(d.toString()))

  const timer = setTimeout(() => proc.kill(), timeoutMs)

  proc.on('close', (code) => {
    clearTimeout(timer)
    res.json({
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exit_code: code ?? -1,
    })
  })

  proc.on('error', (e) => {
    clearTimeout(timer)
    res.status(500).json({ error: e.message })
  })
})
