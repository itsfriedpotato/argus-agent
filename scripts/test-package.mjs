#!/usr/bin/env node
// Pack this repository, install the tarball outside it with an empty home and no
// wallet credentials, then smoke-test the installed CLI and MCP server.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function npmCli() {
  const candidates = [process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../share/nodejs/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !candidate.endsWith('.js')) continue;
    try { await access(candidate); return candidate; } catch { /* Try the next standard Node installation layout. */ }
  }
  throw new Error('Cannot locate npm-cli.js. Run this check through npm run test:package.');
}

/** The packed file list must equal package.json files plus what npm always includes. */
export async function packRepository(destination, child) {
  const metadata = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const packed = JSON.parse((await run(process.execPath, [await npmCli(), 'pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    { ...child, cwd: ROOT })).stdout)[0];
  const actual = packed.files.map(file => file.path).sort();
  const expected = [...new Set([...metadata.files, 'package.json', 'README.md', 'LICENSE'])].sort();
  assert.ok(metadata.files.includes('npm-shrinkwrap.json'), 'The shrinkwrap pins the installed dependency tree');
  assert.deepEqual(actual, expected, 'npm pack contents differ from the reviewed package.json files list');
  return { metadata, tarball: join(destination, packed.filename), size: packed.size, unpackedSize: packed.unpackedSize, files: actual };
}

export async function testPackage({ offline = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'argus package install '));
  const home = join(directory, 'isolated-home');
  await mkdir(home);
  // A package.json here stops npm from installing into a parent folder's project.
  await writeFile(join(directory, 'package.json'), '{"name":"argus-package-acceptance","version":"1.0.0","private":true}\n');
  const userConfig = join(directory, 'user.npmrc');
  const globalConfig = join(directory, 'global.npmrc');
  await writeFile(userConfig, 'registry=https://registry.npmjs.org/\n');
  await writeFile(globalConfig, '');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'),
    LOCALAPPDATA: join(home, 'AppData/Local'), PATH: process.env.PATH ?? dirname(process.execPath),
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
  };
  const child = { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  const { metadata, tarball, size, unpackedSize, files } = await packRepository(directory, child);
  await run(process.execPath, [await npmCli(), 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { ...child, cwd: directory });
  const packageRoot = join(directory, 'node_modules/@argus-world/agent');
  const entry = join(packageRoot, 'scripts/argus-agent/entry.mjs');
  const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(installed.name, metadata.name);
  assert.equal(installed.version, metadata.version);
  assert.equal(installed.license, 'MIT');
  assert.equal(installed.private, undefined);
  for (const path of files.filter(path => path !== 'package.json')) {
    assert.equal(sha256(await readFile(join(packageRoot, path))), sha256(await readFile(join(ROOT, path))), `Installed ${path} differs from the repository`);
  }
  const bin = join(directory, 'node_modules/.bin', process.platform === 'win32' ? 'argus-agent.cmd' : 'argus-agent');
  await access(bin);

  const networkGuard = join(directory, 'package-network-guard.mjs');
  const rpcLog = join(directory, 'package-rpc.jsonl');
  await writeFile(rpcLog, '');
  await writeFile(networkGuard, `import { appendFileSync } from 'node:fs';
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (${offline}) throw new Error('Package smoke operations must work offline');
  const url = new URL(typeof input === 'string' ? input : input.url);
  const request = JSON.parse(init.body);
  if (url.origin !== 'https://rpc.mainnet.arc.io' || request.method !== 'eth_chainId') throw new Error('Only the public chain ID read is allowed in package acceptance');
  appendFileSync(${JSON.stringify(rpcLog)}, JSON.stringify({ origin: url.origin, method: request.method }) + String.fromCharCode(10));
  return originalFetch(input, init);
};\n`);
  const nodeOptions = ['--import', pathToFileURL(networkGuard).href];
  async function invoke(args) {
    const result = await run(process.execPath, [...nodeOptions, entry, ...args], { ...child, cwd: home, timeout: 20_000 });
    assert.ok(result.stdout.trim(), `Installed CLI returned no JSON for ${args[0]}; check its npm entrypoint.`);
    return JSON.parse(result.stdout);
  }
  const help = await invoke(['--help']);
  assert.equal(help.name, 'Argus for Agents');
  assert.equal(help.version, metadata.version);
  if (process.platform !== 'win32') {
    const command = await run(process.execPath, [...nodeOptions, bin, '--help'], { ...child, cwd: home, timeout: 20_000 });
    assert.equal(JSON.parse(command.stdout).name, 'Argus for Agents', 'The npm bin link must execute the CLI');
  }
  assert.match((await readFile(join(packageRoot, 'LICENSE'), 'utf8')).replace(/\r\n/g, '\n'), /^MIT License\n\nCopyright \(c\) 2026 Argus\n/);

  // A fresh read-only workspace at the 100 USDC cap; nothing here signs or submits.
  const setup = await invoke(['setup', '--controller', '0x1111111111111111111111111111111111111111',
    '--circle-wallet', '0x2222222222222222222222222222222222222222', '--budget', '100']);
  assert.equal(setup.executionEnabled, false);
  assert.equal(setup.treasury.toLowerCase(), '0x1111111111111111111111111111111111111111');
  assert.equal(await realpath(setup.skillPath), await realpath(join(packageRoot, 'skills/argus-agent/SKILL.md')));
  const tools = await invoke(['tools']);
  assert.ok(tools.tools.some(tool => tool.name === 'argus_import_project'));
  assert.ok(tools.tools.some(tool => tool.name === 'argus_prepare_project'));
  const projects = await invoke(['argus_list_projects']);
  assert.equal(projects.error, undefined);
  const config = JSON.parse(await readFile(setup.configPath, 'utf8'));
  assert.equal(config.executionEnabled, false);
  assert.equal(config.executor, undefined);
  assert.equal(config.budgetUsdcRaw, '100000000');

  // The installed MCP server over real stdio: initialize, then tools/list.
  const client = new Client({ name: 'argus-package-acceptance', version: metadata.version });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [...nodeOptions, entry, 'mcp'],
    env: { ...env, ARGUS_AGENT_CONFIG: setup.configPath }, cwd: home, stderr: 'pipe' }));
  let mcpTools;
  try {
    assert.equal(client.getServerVersion()?.name, 'argus-agent');
    assert.equal(client.getServerVersion()?.version, metadata.version);
    mcpTools = (await client.listTools()).tools;
  } finally { await client.close(); }
  assert.deepEqual(mcpTools.map(tool => tool.name), tools.tools.map(tool => tool.name), 'MCP and the CLI list the same tools');

  const rpcCalls = (await readFile(rpcLog, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  if (offline) assert.deepEqual(rpcCalls, []);
  const result = { verified: true, platform: process.platform, node: process.versions.node, directory, packageRoot, tarball,
    sizeBytes: size, unpackedSizeBytes: unpackedSize, packedFiles: files.length, toolCount: tools.tools.length, mcpToolCount: mcpTools.length,
    checks: ['packed file list', 'clean external install', 'npm executable', 'installed files equal the repository', 'MIT license', 'help',
      'fresh read-only setup at the 100 USDC cap', 'tool discovery', 'empty project list', 'MCP initialize and tools/list over stdio'],
    transactionsSubmitted: 0, networkMode: offline ? 'disabled_for_operations' : 'chain_id_read_only', rpcCalls };
  await writeFile(join(directory, 'acceptance.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 1 && args[0] === '--offline'))) throw new Error('Usage: node scripts/test-package.mjs [--offline]');
  console.log(JSON.stringify(await testPackage({ offline: args[0] === '--offline' }), null, 2));
}
