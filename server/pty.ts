import { WebSocketServer, WebSocket } from 'ws'
import os from 'node:os'

// Lazy-load node-pty to avoid crashing if native bindings aren't rebuilt yet
let pty: typeof import('node-pty') | null = null
try {
  pty = await import('node-pty')
} catch {
  console.warn('[ckn] node-pty unavailable — terminal feature disabled')
}

/**
 * Each WebSocket connection on /ws?type=pty spawns a dedicated PTY.
 * The browser sends raw keystrokes as text frames; we write them to the PTY.
 * PTY output (text + ANSI escapes) is forwarded back as text frames.
 * A special JSON resize frame { type:'resize', cols, rows } handles terminal resize.
 */
export function setupPty(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '/', `http://localhost`)
    if (url.searchParams.get('type') !== 'pty') return

    if (!pty) {
      ws.send('\r\n[ckn] Terminal unavailable — node-pty not built.\r\n')
      ws.close()
      return
    }

    const shell = process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : 'bash')

    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    })

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })

    term.onExit(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close()
    })

    ws.on('message', (msg) => {
      const raw = msg.toString()
      // Check for resize control frame
      try {
        const parsed = JSON.parse(raw)
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          term.resize(parsed.cols, parsed.rows)
          return
        }
      } catch {}
      term.write(raw)
    })

    ws.on('close', () => term.kill())
    ws.on('error', () => term.kill())
  })
}
