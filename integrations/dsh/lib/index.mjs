// mnema-supervisor —— DSH 插件：托管 mnema 记忆服务（外部 node 进程）
//
// 职责：插件启用 → 拉起 mnema serve；插件停用 / DSH 退出 → 停掉它。
// 服务本身仍是独立进程（不重写记忆逻辑），插件只负责生命周期与状态。
//
// 开关联动：DSH 的启用/停用只改 profile 的 bundles 列表（host-only bundle 不热卸载），
// 这里每 2 秒盯一次该列表：被移除就停服务，被加回就重新拉起。

import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'mnema-supervisor'
export const inject = ['tools']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用后自动拉起 mnema 记忆服务；取消勾选会停掉它'),
  mnemaDir: Schema.string().default('E:\\Code\\mnema').description('mnema 所在目录'),
  port: Schema.natural().default(8321).description('mnema HTTP 端口'),
  db: Schema.string().default('').description('SQLite 数据库路径（留空用默认 mnema-data）'),
  nodePath: Schema.string().default('').description('node 可执行文件（留空用当前 node）'),
  autoStart: Schema.boolean().default(true).description('插件加载时自动启动'),
})

const DEFAULTS = {
  enabled: true,
  mnemaDir: 'E:\\Code\\mnema',
  port: 8321,
  db: '',
  nodePath: '',
  autoStart: true,
  restartBaseMs: 2000,
  restartMaxMs: 60000,
  maxRestarts: 10,
}

const LOG_TAIL = 120

function logFile() {
  try {
    const dir = path.join(DEFAULTS.mnemaDir, 'state')
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'plugin.log')
  } catch {
    return null
  }
}

function log(message) {
  const line = `[mnema-supervisor] ${message}`
  console.error(line)
  try {
    const file = logFile()
    if (!file) return
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`)
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

function isBundleEnabled() {
  try {
    const dir = process.env.DSH_PROFILE_DIR
      || (process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')) + '/profiles/desktop'
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return true
    return bundles.includes('mnema-supervisor')
  } catch {
    return true
  }
}

function portOpen(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    let done = false
    const fin = (v) => { if (!done) { done = true; sock.destroy(); resolve(v) } }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => fin(true))
    sock.once('timeout', () => fin(false))
    sock.once('error', () => fin(false))
  })
}

class MnemaSupervisor {
  constructor(config) {
    this.config = { ...DEFAULTS, ...(config || {}) }
    this.child = null
    this.pid = null
    this.state = 'stopped'
    this.restarts = 0
    this.lastError = null
    this.lastExit = null
    this.startedAt = null
    this.logs = []
    this.disposed = false
    this.restartTimer = null
  }

  get dbPath() {
    return this.config.db || path.join(process.env.USERPROFILE || '', 'mnema-data', 'mnema.db')
  }

  pushLog(line) {
    this.logs.push(String(line))
    if (this.logs.length > LOG_TAIL) this.logs.splice(0, this.logs.length - LOG_TAIL)
  }

  snapshot(extra = {}) {
    return {
      state: this.state,
      pid: this.pid,
      port: this.config.port,
      db: this.dbPath,
      restarts: this.restarts,
      startedAt: this.startedAt,
      lastError: this.lastError,
      lastExit: this.lastExit,
      ...extra,
    }
  }

  async ensure() {
    if (this.disposed) return this.snapshot()
    if (await portOpen(Number(this.config.port))) {
      this.state = 'external'
      log(`检测到 ${this.config.port} 已被占用，按「外部实例」认领，不重复启动`)
      return this.snapshot()
    }
    return this.start()
  }

  async start() {
    if (this.disposed) return this.snapshot()
    if (this.child) return this.snapshot()
    if (await portOpen(Number(this.config.port))) {
      this.state = 'external'
      return this.snapshot()
    }

    const node = this.config.nodePath || process.execPath
    const args = ['src/cli.js', 'serve', '--port', String(this.config.port), '--db', this.dbPath]
    this.state = 'starting'
    try {
      const child = spawn(node, args, {
        cwd: this.config.mnemaDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      this.pid = child.pid
      this.startedAt = new Date().toISOString()

      const onLine = (buf) => {
        for (const line of String(buf).split(/\r?\n/)) {
          if (!line.trim()) continue
          this.pushLog(line)
          if (/Error|error:|EADDRINUSE/.test(line)) this.lastError = line.trim()
        }
      }
      child.stdout?.on('data', onLine)
      child.stderr?.on('data', onLine)

      child.once('error', (err) => {
        this.lastError = `spawn 失败：${err?.message ?? err}`
        this.state = 'failed'
        log(this.lastError)
      })

      child.once('exit', (code, signal) => {
        const wasDisposed = this.disposed
        this.lastExit = { code, signal, at: new Date().toISOString() }
        this.child = null
        this.pid = null
        if (wasDisposed) { this.state = 'stopped'; return }
        if (code === 2 || /已有实例|EADDRINUSE/.test(this.lastError || '')) {
          this.state = 'external'
          log('mnema 报告端口被占用，转为认领外部实例')
          return
        }
        log(`mnema 退出 code=${code} signal=${signal}，准备重启`)
        this.scheduleRestart()
      })

      log(`已启动 mnema pid=${child.pid} port=${this.config.port} db=${this.dbPath}`)
      const ok = await this.waitPort(Number(this.config.port), 15000)
      this.state = ok ? 'ready' : 'starting'
      if (ok) log('mnema 就绪')
      return this.snapshot()
    } catch (error) {
      this.state = 'failed'
      this.lastError = `启动失败：${error?.message ?? error}`
      log(this.lastError)
      return this.snapshot()
    }
  }

  async waitPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await portOpen(port)) return true
      await new Promise((r) => { const t = setTimeout(r, 600); t.unref?.() })
    }
    return false
  }

  scheduleRestart() {
    if (this.disposed) return
    if (this.restarts >= this.config.maxRestarts) {
      this.state = 'failed'
      log(`重启次数达上限（${this.config.maxRestarts}），停止重试`)
      return
    }
    this.restarts += 1
    const wait = Math.min(this.config.restartBaseMs * 2 ** (this.restarts - 1), this.config.restartMaxMs)
    log(`${wait}ms 后第 ${this.restarts} 次重启`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start().catch((e) => log(`重启失败：${e?.message ?? e}`))
    }, wait)
    this.restartTimer.unref?.()
  }

  async stop() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const child = this.child
    this.child = null
    const pid = child?.pid ?? this.pid
    this.pid = null
    this.state = 'stopped'
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        await new Promise((r) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => r()))
      } else {
        child?.kill('SIGTERM')
      }
    } catch { /* 忽略 */ }
    log(`已停止 mnema pid=${pid}`)
  }

  dispose() {
    this.disposed = true
    const pid = this.child?.pid ?? this.pid
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    if (pid) {
      try {
        if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {})
        else this.child?.kill('SIGTERM')
      } catch { /* 忽略 */ }
    }
    this.child = null
    this.pid = null
    this.state = 'stopped'
  }

  revive() {
    this.disposed = false
    this.restarts = 0
    this.state = 'stopped'
  }
}

function toolDef(name, description, properties, required, run) {
  const parameters = {
    type: 'object',
    properties: properties ?? {},
    ...(Array.isArray(required) && required.length ? { required } : {}),
  }
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args) => run(args || {}),
  }
}

export function apply(ctx, config) {
  const sup = new MnemaSupervisor(config)
  const bundleOn = isBundleEnabled()
  const startNow = sup.config.enabled !== false && bundleOn && sup.config.autoStart
  log(`插件已加载 enabled=${sup.config.enabled} autoStart=${sup.config.autoStart} bundleOn=${bundleOn} dir=${sup.config.mnemaDir}`)
  if (!startNow) {
    log('当前为停用状态：不自动启动，仅保留开关监听')
    try { sup.dispose() } catch { /* 忽略 */ }
  }

  const tools = [
    toolDef('mnema_status', '查看 mnema 记忆服务的托管状态（进程、端口、重启次数、最近日志）。', { lines: { type: 'number', description: '日志行数，默认 20' } }, [], async (args) => {
      const n = Math.max(0, Math.min(LOG_TAIL, Number(args.lines ?? 20)))
      return JSON.stringify(sup.snapshot({ logs: n ? sup.logs.slice(-n) : [] }), null, 2)
    }),
    toolDef('mnema_restart', '重启 mnema 记忆服务。', {}, [], async () => {
      await sup.stop()
      sup.restarts = 0
      return JSON.stringify(await sup.start(), null, 2)
    }),
  ]

  const disposers = []
  for (const def of tools) {
    try {
      const d = ctx.tools.register(def)
      if (typeof d === 'function') disposers.push(d)
    } catch (e) {
      const msg = e?.message ?? String(e)
      if (!/already registered/i.test(msg)) log(`工具 ${def.name} 注册失败：${msg}`)
    }
  }

  if (startNow) {
    setTimeout(() => { sup.ensure().catch((e) => log(`自动启动失败：${e?.message ?? e}`)) }, 0).unref?.()
  }

  // 插件开关联动
  let lastEnabled = isBundleEnabled()
  const bundleTimer = setInterval(() => {
    try {
      const now = isBundleEnabled()
      if (now === lastEnabled) return
      lastEnabled = now
      if (!now) {
        log('检测到插件已被停用（移出 bundles）：停止 mnema')
        sup.dispose()
      } else {
        log('检测到插件已重新启用：拉起 mnema')
        sup.revive()
        sup.ensure().catch((e) => log(`重新启用失败：${e?.message ?? e}`))
      }
    } catch (e) {
      log(`开关轮询异常：${e?.message ?? e}`)
    }
  }, 2000)
  bundleTimer.unref?.()

  ctx.on?.('dispose', () => {
    clearInterval(bundleTimer)
    for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } }
    sup.dispose()
  })
}

export { MnemaSupervisor }
