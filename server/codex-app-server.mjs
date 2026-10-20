import { spawn } from 'node:child_process'

const STARTUP_TIMEOUT_MS = 15_000

export class CodexAppServer {
  constructor({ onNotification, onRequest }) {
    this.onNotification = onNotification
    this.onRequest = onRequest
    this.child = null
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    this.stderr = ''
  }

  async start() {
    const command = process.env.CODEX_CLI_PATH?.trim() || 'codex'
    this.child = spawn(command, ['app-server', '--listen', 'stdio://'], {
      cwd: process.cwd(),
      env: process.env,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.#read(chunk))
    this.child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000)
    })
    this.child.on('error', error => this.#fail(error))
    this.child.on('close', code => {
      this.closed = true
      this.#fail(new Error(`Codex app-server exited (${code ?? 'unknown code'})`))
    })

    await this.request('initialize', {
      clientInfo: { name: 'agent-team-workbench', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, STARTUP_TIMEOUT_MS)
    this.notify('initialized', {})
    return this
  }

  request(method, params = {}, timeoutMs = 60_000) {
    if (this.closed || !this.child || this.child.stdin.destroyed) {
      return Promise.reject(new Error('Codex app-server is not running'))
    }

    const id = this.nextId++
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.child.stdin.write(`${message}\n`, error => {
        if (!error) return
        const request = this.pending.get(id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  notify(method, params = {}) {
    if (this.closed || !this.child || this.child.stdin.destroyed) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  respond(id, result) {
    if (this.closed || !this.child || this.child.stdin.destroyed) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  rejectRequest(id, code, message) {
    if (this.closed || !this.child || this.child.stdin.destroyed) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
  }

  stop() {
    if (this.closed) return
    this.closed = true
    this.child?.kill()
    this.#fail(new Error('Codex app-server stopped'))
  }

  #read(chunk) {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.#handle(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  #handle(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.onNotification?.({ method: 'protocol/warning', params: { message: 'Codex returned an unreadable protocol event.' } })
      return
    }

    if (Object.hasOwn(message, 'id') && !message.method) {
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message || `${request.method} failed`))
      else request.resolve(message.result)
      return
    }

    if (Object.hasOwn(message, 'id') && message.method) {
      this.onRequest?.({ id: message.id, method: message.method, params: message.params ?? {} })
      return
    }

    if (typeof message.method === 'string') {
      this.onNotification?.({ method: message.method, params: message.params ?? {} })
    }
  }

  #fail(error) {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer)
      request.reject(error)
      this.pending.delete(id)
    }
  }
}
