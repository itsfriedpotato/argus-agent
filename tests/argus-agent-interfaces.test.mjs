import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { runCli } from '../scripts/argus-agent/cli.mjs';
import { catalog, validateOperation } from '../scripts/argus-agent/catalog.mjs';
import { readFileSync } from 'node:fs';

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const exec = promisify(execFile);
const SECRET = 'provider-secret-must-not-appear';
const names = catalog.map(tool => tool.name);
const ACTION_ID = '00000000-0000-4000-8000-000000000000';
const THROW_ID = '00000000-0000-4000-8000-000000000001';
const BLOCK_ID = '00000000-0000-4000-8000-000000000002';
const TOKEN = '0x1111111111111111111111111111111111111111';
const inputs = {
  argus_import_project: { token: TOKEN, launchTxHash: `0x${"11".repeat(32)}` },
  argus_export_projects: {},
  argus_recover_position: { token: TOKEN },
  argus_prepare_project: { idempotencyKey: 'project-test', brand: { name: 'Fixture', symbol: 'FIX', description: 'Test only', imageURI: 'ipfs://fixture' } },
  argus_get_action: { actionId: ACTION_ID },
  argus_cancel_action: { actionId: ACTION_ID },
  argus_reconcile_transaction: { actionId: ACTION_ID, stepIndex: 0, transactionHash: `0x${"22".repeat(32)}` },
  argus_execute_action: { actionId: ACTION_ID },
  argus_list_projects: {},
  argus_get_project: { token: TOKEN },
  argus_get_token_details: { token: TOKEN },
  argus_get_claim_details: { token: TOKEN },
  argus_get_wallet_balances: { account: TOKEN, tokens: [TOKEN] },
  argus_get_lock: { lockId: '1' },
  argus_list_locks: { owner: TOKEN },
  argus_search_projects: { query: 'fixture' },
  argus_prepare_management: { idempotencyKey: 'manage-test', token: TOKEN, operation: 'claim_fees' },
  argus_prepare_lock: { idempotencyKey: 'lock-test', token: TOKEN, operation: 'permanent', amountRaw: '1' },
  argus_prepare_trade: { idempotencyKey: 'trade-test', token: TOKEN, side: 'buy', amountIn: '1' },
};

// One fake engine is reused for both transports. Business-policy tests belong
// to the shared engine; these tests exercise interface delegation and parity.
function fixtureAgent(tools, validate) {
  return {
    catalog: tools,
    async dispatch(name, args) {
      let parsed;
      try { parsed = validate(name, args); }
      catch (error) { return { error: { code: error.code, message: error.message } }; }
      if (args.actionId === '00000000-0000-4000-8000-000000000001') throw new Error('provider-secret-must-not-appear');
      if (args.actionId === '00000000-0000-4000-8000-000000000002') return { error: { code: 'ARGUS_EXECUTION_DISABLED', message: 'Execution is disabled in this configured mode.' } };
      return { operation: name, arguments: parsed, status: 'fixture_only' };
    },
  };
}

async function cli(operation, args = {}, agent = fixtureAgent(catalog, validateOperation)) {
  let stdout = '';
  const exitCode = await runCli([operation, '--input', '-'], {
    agent, stdin: Readable.from([JSON.stringify(args)]), write: text => { stdout += text; },
  });
  assert.equal(stdout.trim().split('\n').length, 1, 'CLI writes exactly one JSON line');
  return { result: JSON.parse(stdout), exitCode };
}

async function mcp(t) {
  const moduleUrl = new URL('../scripts/argus-agent/mcp.mjs', import.meta.url).href;
  const catalogUrl = new URL('../scripts/argus-agent/catalog.mjs', import.meta.url).href;
  const script = `
    import { createArgusMcpServer } from ${JSON.stringify(moduleUrl)};
    import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
    import { catalog, validateOperation } from ${JSON.stringify(catalogUrl)};
    const agent = (${fixtureAgent.toString()})(catalog, validateOperation);
    serveStdio(() => createArgusMcpServer(agent), { transport: new StdioServerTransport(process.stdin, process.stdout) });
  `;
  const client = new Client({ name: 'argus-interface-fixture', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', script],
    cwd: fileURLToPath(new URL('../', import.meta.url)), stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('CLI discovery and real MCP stdio expose exactly the same engine catalog and schemas', async t => {
  const client = await mcp(t);
  let stdout = '';
  assert.equal(await runCli(['tools'], { agent: fixtureAgent(catalog, validateOperation), write: text => { stdout += text; } }), 0);
  const direct = JSON.parse(stdout);
  const remote = await client.listTools();
  assert.deepEqual(direct, { tools: catalog });
  assert.deepEqual(remote.tools, direct.tools);
  assert.equal(client.getServerVersion()?.version, packageMetadata.version, 'MCP serverInfo names the package release');
});

test('both interfaces preserve engine results for every operation without rewriting arguments', async t => {
  const client = await mcp(t);
  for (const name of names) {
    const args = inputs[name];
    const direct = await cli(name, args);
    const remote = await client.callTool({ name, arguments: args });
    assert.equal(direct.exitCode, 0);
    assert.equal(remote.isError, undefined);
    assert.deepEqual(remote.structuredContent, direct.result);
    assert.deepEqual(JSON.parse(remote.content[0].text), direct.result);
    assert.deepEqual(direct.result.arguments, validateOperation(name, args));
  }
});

test('shared validation and execution refusals have identical JSON and do not trigger a fallback', async t => {
  const client = await mcp(t);
  for (const [name, args] of [
    ['argus_execute_action', { actionId: BLOCK_ID }],
    ['argus_execute_action', { arbitraryRpc: 'https://rpc.invalid' }],
    ['argus_get_action', { actionId: 42 }],
    ['argus_arbitrary_contract', {}],
  ]) {
    const direct = await cli(name, args);
    const remote = await client.callTool({ name, arguments: args });
    assert.equal(direct.exitCode, 1);
    assert.equal(remote.isError, true);
    assert.deepEqual(remote.structuredContent, direct.result);
    assert.deepEqual(JSON.parse(remote.content[0].text), direct.result);
  }
});

test('unexpected provider exceptions are redacted and never automatically retried', async t => {
  const client = await mcp(t);
  let calls = 0;
  const agent = fixtureAgent(catalog, validateOperation);
  const dispatch = agent.dispatch;
  agent.dispatch = async (...args) => { calls++; return dispatch(...args); };
  const direct = await cli('argus_execute_action', { actionId: THROW_ID }, agent);
  const remote = await client.callTool({ name: 'argus_execute_action', arguments: { actionId: THROW_ID } });
  assert.equal(calls, 1);
  assert.equal(direct.exitCode, 1);
  assert.equal(remote.isError, true);
  assert.deepEqual(remote.structuredContent, direct.result);
  assert.equal(direct.result.error.code, 'ARGUS_REQUEST_FAILED');
  assert.ok(!JSON.stringify(remote).includes(SECRET));
  assert.equal((await client.callTool({ name: 'argus_get_action', arguments: { actionId: ACTION_ID } })).isError, undefined,
    'MCP remains usable after a failed operation');
});

test('CLI reads JSON files and stdin; malformed or oversized input never reaches the engine', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'argus-agent-interface-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify({ actionId: ACTION_ID }));
  let calls = 0;
  const engine = fixtureAgent(catalog, validateOperation);
  const agent = { catalog, dispatch: async (...args) => { calls++; return engine.dispatch(...args); } };
  let stdout = '';
  assert.equal(await runCli(['argus_get_action', '--input', input], { agent, write: text => { stdout += text; } }), 0);
  assert.equal(JSON.parse(stdout).arguments.actionId, ACTION_ID);
  assert.equal(calls, 1);
  for (const body of ['{bad json', 'null', '[]', '"text"', `{"requestId":"${'a'.repeat(65_536)}"}`]) {
    stdout = '';
    assert.equal(await runCli(['argus_prepare_project', '--input', '-'], {
      agent, stdin: Readable.from([body]), write: text => { stdout += text; },
    }), 1);
    assert.equal(JSON.parse(stdout).error.code, 'ARGUS_INVALID_INPUT');
  }
  assert.equal(calls, 1);
});

test('CLI accepts the UTF-8 byte order mark that Windows PowerShell writes to files and pipes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'argus-agent-interface-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ actionId: ACTION_ID }))]);
  const input = join(directory, 'input.json');
  await writeFile(input, body);
  const agent = fixtureAgent(catalog, validateOperation);
  for (const [argv, stdin] of [[['argus_get_action', '--input', input]], [['argus_get_action', '--input', '-'], Readable.from([body])]]) {
    let stdout = '';
    assert.equal(await runCli(argv, { agent, ...(stdin ? { stdin } : {}), write: text => { stdout += text; } }), 0);
    assert.equal(JSON.parse(stdout).arguments.actionId, ACTION_ID);
  }
});

test('inline JSON preserves shared operation results without requiring stdin', async () => {
  for (const name of names) {
    let stdout = '';
    const stdin = { [Symbol.asyncIterator]() { throw new Error('Inline JSON must not read stdin.'); } };
    const code = await runCli([name, '--json', JSON.stringify(inputs[name])], {
      agent: fixtureAgent(catalog, validateOperation), stdin, write: text => { stdout += text; },
    });
    const direct = await cli(name, inputs[name]);
    assert.equal(code, direct.exitCode);
    assert.deepEqual(JSON.parse(stdout), direct.result);
    assert.equal(stdout.trim().split('\n').length, 1);
  }
});

test('inline JSON accepts exactly 64 KiB and rejects oversized bytes, malformed JSON and nonobjects before dispatch', async () => {
  let calls = 0;
  const agent = { catalog, dispatch: async (_name, args) => { calls++; return { accepted: typeof args.padding === 'string' }; } };
  const prefix = '{"padding":"';
  const suffix = '"}';
  const atLimit = `${prefix}${'a'.repeat(65_536 - Buffer.byteLength(prefix + suffix))}${suffix}`;
  assert.equal(Buffer.byteLength(atLimit), 65_536);
  let stdout = '';
  assert.equal(await runCli(['argus_get_action', '--json', atLimit], { agent, write: text => { stdout += text; } }), 0);
  assert.deepEqual(JSON.parse(stdout), { accepted: true });
  for (const input of ['', '{invalid', 'null', '[]', '42', 'true', '"text"', `${atLimit} `, `${prefix}${'é'.repeat(32_768)}${suffix}`]) {
    stdout = '';
    assert.equal(await runCli(['argus_get_action', '--json', input], { agent, write: text => { stdout += text; } }), 1);
    assert.equal(JSON.parse(stdout).error.code, 'ARGUS_INVALID_INPUT');
  }
  assert.equal(calls, 1);
});

test('ambiguous or incomplete input flags never reach the engine', async () => {
  let calls = 0;
  const agent = { catalog, dispatch: async () => { calls++; return {}; } };
  for (const flags of [
    ['--json'], ['--json', '{}', '--input', '-'], ['--input', '-', '--json', '{}'],
    ['--json', '{}', '--json', '{}'], ['--input', '-', '--input', '-'], ['--json', '{}', 'extra'],
  ]) {
    let stdout = '';
    assert.equal(await runCli(['argus_get_action', ...flags], { agent, write: text => { stdout += text; } }), 1);
    assert.equal(JSON.parse(stdout).error.code, 'ARGUS_INVALID_INPUT');
  }
  assert.equal(calls, 0);
});

test('CLI rejects unsupported flags, emits JSON help and closes the engine after one call', async () => {
  let dispatches = 0;
  let closed = 0;
  const agent = { catalog, dispatch: async () => { dispatches++; return { status: 'fixture_only' }; }, close: async () => { closed++; } };
  for (const argv of [[], ['--execute'], ['argus_execute_action', '--rpc', 'https://rpc.invalid'], ['tools', '--input']]) {
    let stdout = '';
    assert.equal(await runCli(argv, { write: text => { stdout += text; } }), 1);
    assert.equal(JSON.parse(stdout).error.code, 'ARGUS_INVALID_INPUT');
  }
  let help = '';
  assert.equal(await runCli(['--help'], { write: text => { help += text; } }), 0);
  assert.match(JSON.parse(help).usage, /--input/);
  assert.match(JSON.parse(help).usage, /--json/);
  assert.equal((await cli('argus_get_action', {}, agent)).exitCode, 0);
  assert.equal(dispatches, 1);
  assert.equal(closed, 1);
});

test('real CLI startup fails closed without an absolute config and does not print provider details', async () => {
  const path = fileURLToPath(new URL('../scripts/argus-agent/cli.mjs', import.meta.url));
  for (const configPath of ['', 'relative-config.json']) {
    try {
      await exec(process.execPath, [path, 'argus_execute_action'], { env: { ARGUS_AGENT_CONFIG: configPath } });
      assert.fail('Missing or relative configuration must not execute.');
    } catch (error) {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).error.code, 'ARGUS_CONFIGURATION');
      assert.equal(error.stderr, '');
    }
  }
});
