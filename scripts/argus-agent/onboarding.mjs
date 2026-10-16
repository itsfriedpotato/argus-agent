import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http, parseUnits } from 'viem';
import { createStore, MAINNET_BUDGET_CAP_USDC_RAW } from './store.mjs';
import { readPrivateJson, writePrivateJson } from './private-files.mjs';
import { buildHostedRuntime, hostedUpstream } from './patch-circle-hosted.mjs';
import { createCircleHostedExecutor, verifyCircleHostedRuntime } from './circle-hosted-executor.mjs';

export const defaultHome = () => join(homedir(), '.argus-agent');
export const defaultConfig = () => process.env.ARGUS_AGENT_CONFIG || join(defaultHome(), 'config.json');
const entryPath = fileURLToPath(new URL('./entry.mjs', import.meta.url));
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const fail = (code, message) => { throw Object.assign(new Error(message), { code, safe: true }); };

export function parseFlags(args, accepted) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!accepted.includes(key) || key in flags || !args[i + 1] || args[i + 1].startsWith('--')) fail('ARGUS_SETUP_ARGUMENTS', `Expected named options: ${accepted.join(', ')}.`);
    flags[key] = args[i + 1];
  }
  return flags;
}

function address(value, label) {
  try { const result = getAddress(value); if (!/^0x0{40}$/i.test(result)) return result; } catch { /* Show a safe input error. */ }
  fail('ARGUS_SETUP_ARGUMENTS', `${label} must be a nonzero wallet address.`);
}

export function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail('ARGUS_NODE_VERSION', 'Install Node.js 22.13 or newer, which includes the required SQLite runtime.');
}

export function setupWorkspace(flags) {
  assertNodeVersion();
  const home = resolve(flags['--home'] || defaultHome());
  const configPath = join(home, 'config.json');
  if (existsSync(configPath) || existsSync(join(home, 'state', 'agent.sqlite'))) fail('ARGUS_WORKSPACE_EXISTS', 'This workspace already exists. Reuse its config; setup never replaces a wallet or journal.');
  const controller = address(flags['--controller'], 'Human controller');
  const operator = address(flags['--circle-wallet'], 'Circle wallet');
  if (same(controller, operator)) fail('ARGUS_SETUP_ARGUMENTS', 'Use an independently controlled human wallet as the creator-fee controller.');
  const treasuryChoice = flags['--treasury'] || 'human';
  if (!['human', 'circle'].includes(treasuryChoice)) fail('ARGUS_SETUP_ARGUMENTS', 'Choose treasury human or circle.');
  const budget = flags['--budget'] || '10';
  // The format check refuses digits parseUnits would round away; the range is checked on the exact amount.
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,6})?$/.test(budget)) fail('ARGUS_SETUP_ARGUMENTS', 'Choose a positive cumulative USDC budget of at most 100, with up to 6 decimals.');
  const budgetUsdcRaw = parseUnits(budget, 6).toString();
  if (BigInt(budgetUsdcRaw) <= 0n || BigInt(budgetUsdcRaw) > MAINNET_BUDGET_CAP_USDC_RAW) fail('ARGUS_SETUP_ARGUMENTS', 'Budget must be greater than zero and at most 100 USDC.');
  const rpcUrl = flags['--rpc'] || 'https://rpc.mainnet.arc.io';
  if (!['https://rpc.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io'].includes(rpcUrl)) fail('ARGUS_SETUP_ARGUMENTS', 'Use a supported Arc mainnet RPC endpoint.');
  if (Boolean(flags['--service-url']) !== Boolean(flags['--service-token-file'])) fail('ARGUS_SETUP_ARGUMENTS', 'Provide both the shared service URL and its private access token file.');
  if (Boolean(flags['--circle-cli']) !== Boolean(flags['--circle-home'])) fail('ARGUS_SETUP_ARGUMENTS', 'Provide both Circle runtime and session paths.');
  const identity = { experimentId: randomUUID(), chainId: 5042, circleWallet: operator, fundingWallet: controller };
  const config = { mode: 'mainnet-mvp', executionEnabled: false, chainId: 5042, rpcUrl,
    stateDir: join(home, 'state'), budgetUsdcRaw, identity,
    actors: { operator, controller, treasury: treasuryChoice === 'circle' ? operator : controller } };
  if (flags['--service-url']) config.betaService = { url: flags['--service-url'], tokenFile: resolve(flags['--service-token-file']) };
  if (flags['--circle-cli']) config.executor = { kind: 'circle-hosted', cliPath: resolve(flags['--circle-cli']), cliHome: resolve(flags['--circle-home']) };
  else if (existsSync(join(home, 'circle-runtime.json'))) config.executor = readPrivateJson(join(home, 'circle-runtime.json'));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const store = createStore(config.stateDir, { mode: 'mainnet-mvp', initialization: 'create', identity, budgetUsdcRaw });
  store.close();
  writePrivateJson(configPath, config, { exclusive: true });
  const mcp = { mcpServers: { argus: { command: process.execPath, args: [entryPath, 'mcp'], env: { ARGUS_AGENT_CONFIG: configPath } } } };
  const mcpConfigPath = join(home, 'mcp.json');
  writePrivateJson(mcpConfigPath, mcp, { exclusive: true });
  return { status: 'configured', configPath, mcpConfigPath, executionEnabled: false, chainId: 5042,
    controller, circleWallet: operator, treasury: config.actors.treasury, cumulativeBudgetUsdc: budget,
    skillPath: fileURLToPath(new URL('../../skills/argus-agent/SKILL.md', import.meta.url)),
    next: 'Import a project or run doctor. Enable execution separately after Circle authentication. Setup does not submit transactions.' };
}

function sanitizedChildEnv() {
  return Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
}

function circleAuthentication(home) {
  return { command: 'argus-agent', args: ['circle', '--home', home],
    steps: ['terms show', 'terms accept (only after you review and accept)', 'wallet login YOUR_EMAIL --type agent', 'wallet list --type agent --chain ARC --output json'],
    instructions: 'Run interactive login in your own terminal and enter the email code there. Agents must not capture the code. The same email restores existing wallets; first login provisions them automatically. Do not run wallet create after login.' };
}

/** Interactive Circle commands inherit the human terminal; no OTP is captured by Argus. */
export async function runCircle(args, { home, run, verifyRuntime = verifyCircleHostedRuntime } = {}) {
  assertNodeVersion();
  const configPath = home ? join(resolve(home), 'config.json') : defaultConfig();
  const metadataPath = join(dirname(configPath), 'circle-runtime.json');
  const config = existsSync(configPath) ? readPrivateJson(configPath) : null;
  const executor = config?.executor || (existsSync(metadataPath) ? readPrivateJson(metadataPath) : null);
  if (!executor || executor.kind !== 'circle-hosted' || ![executor.cliPath, executor.cliHome].every(path => typeof path === 'string' && isAbsolute(path)))
    fail('ARGUS_CIRCLE_NOT_INSTALLED', 'Run circle-setup for this workspace before using Circle commands.');
  try { verifyRuntime(executor.cliPath); }
  catch { fail('ARGUS_CIRCLE_RUNTIME', 'The pinned Circle runtime could not be verified. Restore its installed files before authenticating.'); }
  const env = { ...sanitizedChildEnv(), CIRCLE_CLI_HOME: executor.cliHome, CIRCLE_VERSION_CHECK: 'off', DO_NOT_TRACK: '1' };
  const invoke = run || ((command, arguments_, options) => new Promise((yes, no) => {
    const child = spawn(command, arguments_, options);
    child.once('error', no);
    child.once('exit', (code, signal) => yes(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
  }));
  try { return await invoke(process.execPath, [executor.cliPath, ...(args.length ? args : ['--help'])], { env, stdio: 'inherit', windowsHide: false }); }
  catch { fail('ARGUS_CIRCLE_START_FAILED', 'The Circle command could not start. Check the installed runtime and try again in your own terminal.'); }
}

export async function installCircle(flags, { run } = {}) {
  const home = resolve(flags['--home'] || defaultHome());
  const runtime = join(home, 'circle-runtime');
  const cliHome = join(home, 'circle-session');
  const metadataPath = join(home, 'circle-runtime.json');
  if (existsSync(metadataPath)) return { status: 'already_installed', ...readPrivateJson(metadataPath), authentication: circleAuthentication(home), next: 'Reuse this Circle session. Authenticate in your own terminal if it has expired.' };
  const candidates = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../share/nodejs/npm/bin/npm-cli.js')];
  const npmCli = candidates.find(existsSync);
  if (!npmCli && !run) fail('ARGUS_NPM_UNAVAILABLE', 'Install Node.js with npm, then run circle-setup again.');
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  mkdirSync(cliHome, { recursive: true, mode: 0o700 });
  const args = [npmCli || 'npm-cli.js', 'install', '--prefix', runtime, '--no-audit', '--no-fund', `${hostedUpstream.package}@${hostedUpstream.version}`];
  const invoke = run || ((command, arguments_) => new Promise((yes, no) => execFile(command, arguments_,
    { env: sanitizedChildEnv(), timeout: 180_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, error => error ? no(error) : yes())));
  try { await invoke(process.execPath, args); buildHostedRuntime(runtime); }
  catch { fail('ARGUS_CIRCLE_INSTALL_FAILED', 'The pinned Circle runtime could not be installed or verified. No wallet was created and no terms were accepted.'); }
  const executor = { kind: 'circle-hosted', cliPath: join(runtime, 'circle-hosted.mjs'), cliHome };
  writePrivateJson(metadataPath, executor, { exclusive: true });
  const configPath = join(home, 'config.json');
  if (existsSync(configPath)) {
    const config = readPrivateJson(configPath);
    if (config.mode !== 'mainnet-mvp' || config.executionEnabled) fail('ARGUS_SETUP_ARGUMENTS', 'Attach a Circle runtime only to a disabled MVP workspace.');
    writePrivateJson(configPath, { ...config, executor });
  }
  return { status: 'installed', ...executor, runtimeVersion: hostedUpstream.version,
    authentication: circleAuthentication(home),
    next: 'Authenticate interactively in your own terminal, then list existing ARC wallets. Login provisions or restores wallets; do not create a replacement. Run setup with the returned wallet address.' };
}

export async function doctor(configPath = defaultConfig(), { client, circle } = {}) {
  assertNodeVersion();
  const config = readPrivateJson(configPath);
  if (config.mode !== 'mainnet-mvp') fail('ARGUS_SETUP_ARGUMENTS', 'Doctor targets an MVP workspace; historical pilot configuration is left unchanged.');
  const checks = { node: true, configuration: true, journal: existsSync(join(config.stateDir, 'agent.sqlite')) };
  const rpc = client || createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0, timeout: 15000, fetchOptions: { redirect: 'error' } }) });
  try { checks.arcMainnet = await rpc.getChainId() === 5042; } catch { checks.arcMainnet = false; }
  let wallet = { ready: false, code: 'CIRCLE_NOT_CONFIGURED' };
  if (config.executor) {
    try { wallet = await (circle || createCircleHostedExecutor({ ...config.executor, accounts: [config.actors.operator], authorize: async () => false })).preflight(); }
    catch { wallet = { ready: false, code: 'CIRCLE_NOT_READY' }; }
  }
  return { status: Object.values(checks).every(Boolean) ? 'ready_for_reads' : 'needs_setup', checks,
    executionEnabled: config.executionEnabled === true, wallet: { ready: wallet.ready, ...(wallet.code ? { code: wallet.code } : {}) },
    chainId: 5042, controller: config.actors.controller, circleWallet: config.actors.operator, treasury: config.actors.treasury,
    serviceConfigured: Boolean(config.betaService), portability: { platform: process.platform, node: process.versions.node },
    next: wallet.ready ? 'Wallet access is available. Execution still follows the workspace setting and cumulative budget.' : 'Reads and imports do not require Circle login. Use circle-setup and authenticate to execute.' };
}

export async function setExecution(configPath, enabled, dependencies) {
  if (!isAbsolute(configPath)) fail('ARGUS_SETUP_ARGUMENTS', 'Use an absolute config path.');
  const config = readPrivateJson(configPath);
  if (config.mode !== 'mainnet-mvp') fail('ARGUS_SETUP_ARGUMENTS', 'This command cannot reopen the closed historical pilot.');
  if (enabled) {
    const report = await doctor(configPath, dependencies);
    if (report.status !== 'ready_for_reads' || !report.wallet.ready) fail('ARGUS_EXECUTION_NOT_READY', 'Doctor must confirm Arc RPC, the existing journal and access to the configured Circle wallet.');
  }
  writePrivateJson(configPath, { ...config, executionEnabled: enabled });
  return { status: enabled ? 'execution_enabled' : 'execution_disabled', cumulativeBudgetUsdcRaw: config.budgetUsdcRaw,
    note: 'The existing journal, wallet identity and cumulative budget are retained.' };
}
