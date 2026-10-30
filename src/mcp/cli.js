#!/usr/bin/env node
/**
 * mnema MCP server（stdio）
 *
 * 在 MCP 客户端里配置：
 *   { "command": "node", "args": ["E:/Code/mnema/src/mcp/cli.js"] }
 * 可选环境变量：MNEMA_DB / MNEMA_TENANT / MNEMA_EMBED_KIND
 */

import { createEngine } from '../engine.js';
import { createMcpServer } from './server.js';

const engine = createEngine({
  config: {
    storage: { path: process.env.MNEMA_DB ?? './data/mnema.db' },
    embedding: { kind: process.env.MNEMA_EMBED_KIND ?? 'auto' },
    tenant: process.env.MNEMA_TENANT ?? 'default',
  },
});

const server = createMcpServer(engine);
server.start();

const shutdown = () => {
  try {
    engine.close();
  } catch {
    /* 忽略 */
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
