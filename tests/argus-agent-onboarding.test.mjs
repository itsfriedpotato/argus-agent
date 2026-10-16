import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertNodeVersion, doctor, installCircle, parseFlags, runCircle, setExecution, setupWorkspace } from '../scripts/argus-agent/onboarding.mjs';
import { readPrivateJson, writePrivateJson } from '../scripts/argus-agent/private-files.mjs';
import { runEntry } from '../scripts/argus-agent/entry.mjs';
import { loadConfiguredAgent } from '../scripts/argus-agent/cli.mjs';
import { createArgusAgent } from '../scripts/argus-agent/sdk.mjs';

const human = `0x${'12'.repeat(20)}`;
const circle = `0x${'34'.repeat(20)}`;
function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'argus onboard '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const flags = { '--home': root, '--controller': human, '--circle-wallet': circle, '--budget': '5', ...extra };
  const result = setupWorkspace(flags);
  return { flags, result, config: readPrivateJson(result.configPath) };
}

test('setup creates a read-only independent workspace, portable MCP arguments and human treasury', t => {
  const { result, config, flags } = fixture(t);
  assert.equal(config.mode, 'mainnet-mvp');
  assert.equal(config.executionEnabled, false);
  assert.equal(config.budgetUsdcRaw, '5000000');
  assert.equal(config.actors.treasury, human);
  assert.equal(config.executor, undefined);
  const mcp = readPrivateJson(result.mcpConfigPath).mcpServers.argus;
  assert.deepEqual(mcp.env, { ARGUS_AGENT_CONFIG: result.configPath });
  assert.equal(mcp.args.at(-1), 'mcp');
  const before = readFileSync(result.configPath);
  assert.throws(() => setupWorkspace(flags), { code: 'ARGUS_WORKSPACE_EXISTS' });
  assert.deepEqual(readFileSync(result.configPath), before);
});

test('the cap is 100 USDC: setup and the agent accept it, 50 is no longer refused, and 10 stays the default', async t => {
  for (const [budget, raw] of [['100', '100000000'], ['100.000000', '100000000'], ['99.999999', '99999999'], ['50', '50000000'], ['0.000001', '1']]) {
    const { result, config } = fixture(t, { '--budget': budget });
    assert.equal(config.budgetUsdcRaw, raw, budget);
    assert.equal(result.cumulativeBudgetUsdc, budget);
    // Every later CLI or MCP call reloads the workspace, so the agent must open the journal setup created.
    const agent = await loadConfiguredAgent(result.configPath);
    try { const listed = await agent.dispatch('argus_list_projects', {}); assert.equal(listed.error, undefined, JSON.stringify(listed)); }
    finally { await agent.close(); }
  }
  assert.equal(fixture(t, { '--budget': undefined }).config.budgetUsdcRaw, '10000000');
});

test('the agent refuses a workspace budget above the cap or outside the integer format', async t => {
  const { config } = fixture(t, { '--budget': '100' });
  for (const budgetUsdcRaw of ['100000001', '1000000000', '0100000000', '0', '1.5', '1e8']) {
    await assert.rejects(createArgusAgent({ ...config, budgetUsdcRaw }), { code: 'ARGUS_CONFIG_UNSAFE' }, budgetUsdcRaw);
  }
});

test('Circle working treasury is explicit; doctor permits reads without authenticating a wallet', async t => {
  const { config, result } = fixture(t, { '--treasury': 'circle' });
  assert.equal(config.actors.treasury, circle);
  const report = await doctor(result.configPath, { client: { getChainId: async () => 5042 } });
  assert.equal(report.status, 'ready_for_reads');
  assert.equal(report.wallet.ready, false);
  assert.equal(report.executionEnabled, false);
  await assert.rejects(setExecution(result.configPath, true, { client: { getChainId: async () => 5042 } }), { code: 'ARGUS_EXECUTION_NOT_READY' });
});

test('enable verifies the expected Circle wallet and disable retains budget identity', async t => {
  const { config, result } = fixture(t);
  config.executor = { kind: 'circle-hosted', cliPath: '/test/runtime.mjs', cliHome: '/test/private' };
  writePrivateJson(result.configPath, config);
  const deps = { client: { getChainId: async () => 5042 }, circle: { preflight: async () => ({ ready: true }) } };
  await setExecution(result.configPath, true, deps);
  assert.equal(readPrivateJson(result.configPath).executionEnabled, true);
  await setExecution(result.configPath, false);
  const after = readPrivateJson(result.configPath);
  assert.equal(after.executionEnabled, false);
  assert.deepEqual(after.identity, config.identity);
  assert.equal(after.budgetUsdcRaw, config.budgetUsdcRaw);
});

test('MVP lifecycle commands cannot reopen the closed historical pilot', async t => {
  const { config, result } = fixture(t);
  writePrivateJson(result.configPath, { ...config, mode: 'mainnet', executionEnabled: false });
  await assert.rejects(setExecution(result.configPath, true), { code: 'ARGUS_SETUP_ARGUMENTS' });
  assert.equal(readPrivateJson(result.configPath).executionEnabled, false);
});

test('invalid inputs fail before creating state and private configuration never appears in errors', async t => {
  const root = mkdtempSync(join(tmpdir(), 'argus-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const flags = { '--home': root, '--controller': human, '--circle-wallet': circle };
  for (const budget of ['0', '0.000000', '100.000001', '101', '1000', '-1', '1e2', '2.0000001', '100.0000001', '010', '.5', ' 5']) {
    assert.throws(() => setupWorkspace({ ...flags, '--budget': budget }), { code: 'ARGUS_SETUP_ARGUMENTS' }, budget);
  }
  assert.equal(existsSync(join(root, 'config.json')) || existsSync(join(root, 'state')), false);
  assert.throws(() => setupWorkspace({ ...flags, '--circle-wallet': human }));
  assert.throws(() => parseFlags(['--home', root, '--home', root], ['--home']));
  assert.throws(() => assertNodeVersion('22.12.0'), { code: 'ARGUS_NODE_VERSION' });
  assertNodeVersion('22.13.0'); assertNodeVersion('24.0.0');
  let output = '';
  await runEntry(['setup', '--private-secret', 'never-output-this'], { write: value => { output += value; } });
  assert(!output.includes('never-output-this'));
});

test('POSIX-readable private config is rejected, while normal owner file is accepted', { skip: process.platform === 'win32' }, t => {
  const { result } = fixture(t);
  chmodSync(result.configPath, 0o644);
  assert.throws(() => readPrivateJson(result.configPath), { code: 'ARGUS_PRIVATE_FILE' });
  chmodSync(result.configPath, 0o600);
  assert.equal(readPrivateJson(result.configPath).mode, 'mainnet-mvp');
  writeFileSync(result.configPath, '[]');
  assert.throws(() => readPrivateJson(result.configPath), { code: 'ARGUS_PRIVATE_FILE' });
});

test('Circle passthrough works before workspace setup and preserves interactive stdio and exact arguments', async t => {
  const home = mkdtempSync(join(tmpdir(), 'argus circle terminal '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const executor = { kind: 'circle-hosted', cliPath: join(home, 'runtime with spaces', 'circle.mjs'), cliHome: join(home, 'session') };
  writePrivateJson(join(home, 'circle-runtime.json'), executor);
  const args = ['wallet', 'login', 'person@example.com', '--type', 'agent'];
  let calls = 0;
  const code = await runCircle(args, { home, verifyRuntime: path => assert.equal(path, executor.cliPath),
    run: async (command, actual, options) => {
      calls++;
      assert.equal(command, process.execPath);
      assert.deepEqual(actual, [executor.cliPath, ...args]);
      assert.equal(options.stdio, 'inherit', 'OTP input is never captured or buffered by the Argus wrapper');
      assert.equal(options.windowsHide, false);
      assert.equal(options.env.CIRCLE_CLI_HOME, executor.cliHome);
      assert.equal(options.env.CIRCLE_VERSION_CHECK, 'off');
      const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'CIRCLE_CLI_HOME', 'CIRCLE_VERSION_CHECK', 'DO_NOT_TRACK']);
      assert.ok(Object.keys(options.env).every(key => allowed.has(key)));
      return 7;
    } });
  assert.equal(code, 7);
  assert.equal(calls, 1);
});

test('Circle passthrough prefers the configured executor and refuses unverifiable runtime before spawn', async t => {
  const { result, config, flags } = fixture(t);
  const home = flags['--home'];
  config.executor = { kind: 'circle-hosted', cliPath: join(home, 'configured.mjs'), cliHome: join(home, 'configured-session') };
  writePrivateJson(result.configPath, config);
  writePrivateJson(join(home, 'circle-runtime.json'), { ...config.executor, cliPath: join(home, 'unused.mjs') });
  let calls = 0;
  const run = async (_command, args) => { calls++; assert.deepEqual(args, [config.executor.cliPath, '--help']); return 0; };
  assert.equal(await runCircle([], { home, run, verifyRuntime: path => assert.equal(path, config.executor.cliPath) }), 0);
  await assert.rejects(runCircle(['--help'], { home, run, verifyRuntime: () => { throw new Error('private runtime detail'); } }), { code: 'ARGUS_CIRCLE_RUNTIME' });
  assert.equal(calls, 1);
});

test('existing Circle installation returns cross-shell login instructions without creating another wallet or session', async t => {
  const home = mkdtempSync(join(tmpdir(), 'argus circle guidance '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const metadata = join(home, 'circle-runtime.json');
  writePrivateJson(metadata, { kind: 'circle-hosted', cliPath: join(home, 'circle.mjs'), cliHome: join(home, 'session') });
  const before = readFileSync(metadata);
  const result = await installCircle({ '--home': home }, { run: () => { throw new Error('Should not reinstall'); } });
  assert.equal(result.status, 'already_installed');
  assert.equal(result.authentication.command, 'argus-agent');
  assert.deepEqual(result.authentication.args, ['circle', '--home', home]);
  assert.match(result.authentication.instructions, /Agents must not capture the code/);
  assert.match(result.authentication.instructions, /Do not run wallet create/);
  assert.deepEqual(readFileSync(metadata), before);
});

test('Circle passthrough missing installation and malformed home fail without running another command', async t => {
  const home = mkdtempSync(join(tmpdir(), 'argus no circle '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await assert.rejects(runCircle(['--help'], { home, run: () => { throw new Error('Must not spawn'); } }), { code: 'ARGUS_CIRCLE_NOT_INSTALLED' });
  let output = '';
  assert.equal(await runEntry(['circle', '--home'], { write: value => { output += value; } }), 1);
  assert.equal(JSON.parse(output).error.code, 'ARGUS_SETUP_ARGUMENTS');
});
