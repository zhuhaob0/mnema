/**
 * mnema 守护进程：拉起 serve，退出后自动重启（指数退避）
 *
 * 由 start-hidden.vbs 在登录时以隐藏窗口启动，因此不会出现终端窗口。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const LOG = path.join(ROOT, 'state', 'supervisor.log');
const DB = process.env.MNEMA_DB ?? path.join(process.env.USERPROFILE ?? '', 'mnema-data', 'mnema.db');
const PORT = process.env.MNEMA_PORT ?? '8321';

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

let child = null;
let stopping = false;
let backoff = 2000;

function start() {
  if (stopping) return;
  child = spawn(process.execPath, ['src/cli.js', 'serve', '--port', PORT, '--db', DB], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  log(`start pid=${child.pid} port=${PORT} db=${DB}`);

  child.once('exit', (code, signal) => {
    const pid = child?.pid;
    child = null;
    log(`exit pid=${pid} code=${code} signal=${signal}`);
    if (stopping) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 60000);
    log(`restart in ${wait}ms`);
    setTimeout(start, wait);
  });
}

function shutdown(reason) {
  stopping = true;
  log(`shutdown (${reason})`);
  if (child) {
    try { child.kill(); } catch { /* 忽略 */ }
  }
  setTimeout(() => process.exit(0), 500).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  log(`uncaught: ${error?.message ?? error}`);
  shutdown('uncaughtException');
});

// 启动
start();
