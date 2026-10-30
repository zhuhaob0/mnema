#!/usr/bin/env node
/**
 * mnema CLI
 *
 *   mnema serve [--port 8321] [--db ./data/mnema.db] [--token xxx]
 *   mnema stats [--db ...]
 */

import { createEngine } from './engine.js';
import { createHttpServer } from './http/server.js';

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.flags[key] = next;
        i += 1;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

const { _: rest, flags } = parseArgs(process.argv.slice(2));
const command = rest[0] ?? 'serve';

const config = {};
if (flags.db) config.storage = { path: flags.db };
if (flags.port) config.http = { port: Number(flags.port) };
if (flags.host) config.http = { ...(config.http ?? {}), host: flags.host };
if (flags.token) config.http = { ...(config.http ?? {}), token: flags.token };
if (flags.tenant) config.tenant = flags.tenant;
if (flags.embed) config.embedding = { kind: flags.embed };
if (flags['embed-url']) {
  config.embedding = { ...(config.embedding ?? {}), url: flags['embed-url'] };
}

const engine = createEngine({ config });

if (command === 'stats') {
  console.log(JSON.stringify({ schema: engine.schema, stats: engine.stats() }, null, 2));
  engine.close();
  process.exit(0);
}

if (command === 'narrative') {
  const result = engine.regenerateNarrative();
  console.log(result.markdown);
  engine.close();
  process.exit(0);
}

if (command === 'consolidate') {
  const result = await engine.consolidate();
  console.log(JSON.stringify(result, null, 2));
  engine.close();
  process.exit(0);
}

if (command !== 'serve') {
  console.error(`未知命令: ${command}\n用法: mnema serve | mnema stats`);
  process.exit(1);
}

const http = createHttpServer(engine);
const addr = await http.listen();
console.log(`mnema listening on http://${addr.address}:${addr.port}`);
console.log(`  schema v${engine.schema.schemaVersion} · tenant=${engine.config.tenant} · embedding=${engine.embedding.activeKind}`);
console.log(`  db: ${engine.config.storage.path}`);

// 夜间巩固调度（默认 03:30，可用 --at 或 MNEMA_CONSOLIDATE_AT 改）
const at = String(flags.at ?? process.env.MNEMA_CONSOLIDATE_AT ?? '03:30');
const [hh, mm] = at.split(':').map(Number);
let lastRunDay = null;
const scheduler = setInterval(async () => {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getHours() !== hh || now.getMinutes() !== mm || lastRunDay === day) return;
  lastRunDay = day;
  try {
    const result = await engine.consolidate();
    console.log('[consolidate]', JSON.stringify(result));
  } catch (error) {
    console.error('[consolidate] 失败:', error?.message ?? error);
  }
}, 60_000);
scheduler.unref?.();
if (Number.isFinite(hh) && Number.isFinite(mm)) {
  console.log(`  consolidation scheduled at ${at} daily`);
}

const shutdown = async () => {
  clearInterval(scheduler);
  await http.close();
  engine.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
