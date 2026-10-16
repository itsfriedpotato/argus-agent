#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { json, loadConfiguredAgent, requestFailure } from './cli.mjs';

export function createArgusMcpServer(agent) {
  const server = new Server({ name: 'argus-agent', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: agent.catalog }));
  server.setRequestHandler('tools/call', async request => {
    let result;
    try { result = await agent.dispatch(request.params.name, request.params.arguments ?? {}); }
    catch { result = requestFailure(); }
    const text = json(result);
    return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text), ...(result?.error ? { isError: true } : {}) };
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const agent = await loadConfiguredAgent();
    const handle = serveStdio(() => createArgusMcpServer(agent), {
      transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128 * 1024 }),
    });
    const close = async () => { await handle.close(); await agent.close?.(); };
    process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
    process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
  } catch {
    process.stderr.write(`${json(requestFailure())}\n`);
    process.exitCode = 1;
  }
}
