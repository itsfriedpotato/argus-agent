import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { decodeFunctionData, encodeFunctionData, formatUnits, parseAbiItem, toFunctionSignature } from 'viem';

const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const problem = (code, message) => Object.assign(new Error(message), { code });
const decimal = value => {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,79})$/.test(text)) throw problem('CIRCLE_INVALID_TRANSACTION', 'Amounts must be non-negative decimal integers.');
  return text;
};
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
function positionalValue(parameter, value) {
  if (/\[[0-9]*\]$/.test(parameter.type)) return value.map(item => positionalValue({ ...parameter, type: parameter.type.replace(/\[[0-9]*\]$/, '') }, item));
  if (parameter.type === 'tuple') return parameter.components.map((component, index) => positionalValue(component, Array.isArray(value) ? value[index] : value[component.name]));
  return value;
}

/** Roundtrip against one exact ABI item. Integers remain strings, including inside tuples. */
export function circleArguments(data, abis) {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(data)) throw problem('CIRCLE_INVALID_CALLDATA', 'An ABI-encoded contract call is required.');
  for (const item of abis.flat(Infinity).filter(item => item?.type === 'function')) {
    try {
      const decoded = decodeFunctionData({ abi: [item], data });
      const args = decoded.args ?? [];
      if (!same(encodeFunctionData({ abi: [item], functionName: item.name, args }), data)) continue;
      const signature = toFunctionSignature(item);
      const serialized = args.map((value, index) => json(positionalValue(item.inputs[index], value)));
      // This is the patched CLI's conversion. Stock CLI passes strings directly.
      if (!same(encodeFunctionData({ abi: [parseAbiItem(`function ${signature}`)], functionName: item.name, args: serialized.map(value => JSON.parse(value)) }), data)) continue;
      return { signature, parameters: serialized };
    } catch { /* Try the next configured selector; never guess a function signature. */ }
  }
  throw problem('CIRCLE_UNSUPPORTED_ABI', 'No configured ABI reproduces the exact transaction calldata.');
}

function childRun(path, args, { env, timeoutMs }) {
  return new Promise(resolveResult => {
    execFile(process.execPath, [path, ...args], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolveResult({ code: error ? error.code : 0, stdout, stderr, interrupted: Boolean(error?.killed || error?.signal) });
    });
  });
}

export function verifyCircleRuntime(cliPath) {
  const manifest = JSON.parse(readFileSync(join(dirname(cliPath), 'local-patch.json'), 'utf8'));
  const digest = createHash('sha256').update(readFileSync(cliPath)).digest('hex');
  if (manifest.patchId !== 'argus-local-compat-v1' || manifest.upstreamVersion !== '1.1.4' || !manifest.localOnly || manifest.patchedSha256 !== digest) {
    throw problem('CIRCLE_RUNTIME_MISMATCH', 'Pinned local Circle compatibility runtime failed provenance verification.');
  }
  return manifest;
}

/** Local-fork compatibility adapter. No hosted Circle session, mainnet or terms auto-acceptance. */
export function createCircleExecutor({ cliPath, cliHome, vaultPath, rpcUrl, chainId = 5042, accounts, abis = [], authorize, timeoutMs = 30_000,
  run = childRun, fetchImpl = fetch } = {}) {
  for (const [label, path] of Object.entries({ cliPath, cliHome, vaultPath })) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw problem('CIRCLE_CONFIGURATION', `${label} must be an absolute isolated path.`);
  }
  if (resolve(cliHome) === resolve(vaultPath)) throw problem('CIRCLE_CONFIGURATION', 'CLI session and wallet vault directories must differ.');
  const endpoint = new URL(rpcUrl);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.hash) {
    throw problem('CIRCLE_LOCAL_ONLY', 'This proof only accepts numeric loopback HTTP RPC endpoints.');
  }
  if (chainId !== 5042 || !Array.isArray(accounts) || !accounts.length || accounts.some(item => typeof item !== 'string' || !address.test(item))) {
    throw problem('CIRCLE_CONFIGURATION', 'Configure Arc chain 5042 and explicit permitted local accounts.');
  }
  accounts = Object.freeze([...accounts]);
  if (typeof authorize !== 'function') throw problem('CIRCLE_CONFIGURATION', 'An explicit action authorization callback is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw problem('CIRCLE_CONFIGURATION', 'Invalid command timeout.');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', CIRCLE_CLI_HOME: cliHome, CIRCLE_ARGUS_VAULT_PATH: vaultPath,
    CIRCLE_ARGUS_JSON_ARGS: '1', CIRCLE_VERSION_CHECK: 'off', DO_NOT_TRACK: '1' };
  // Never forward HOME, Circle authentication, private keys, or terms-acceptance variables.
  const invoke = args => run(cliPath, args, { env: { ...env }, timeoutMs });
  let rpcId = 0;
  async function rpc(method, params = []) {
    const id = ++rpcId;
    const response = await fetchImpl(endpoint.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (!response.ok) throw problem('CIRCLE_RPC_UNAVAILABLE', 'Local RPC is unavailable.');
    const payload = await response.json();
    if (payload.id !== id || payload.error || !Object.hasOwn(payload, 'result')) throw problem('CIRCLE_RPC_UNAVAILABLE', 'Local RPC returned an invalid response.');
    return payload.result;
  }
  async function verifyChain() {
    const [actualChain, version] = await Promise.all([rpc('eth_chainId'), rpc('web3_clientVersion')]);
    if (BigInt(actualChain) !== BigInt(chainId) || typeof version !== 'string' || !/^anvil\b/i.test(version)) {
      throw problem('CIRCLE_LOCAL_ONLY', 'Expected an Arc Anvil fork.');
    }
  }
  async function preflight() {
    try {
      const manifest = verifyCircleRuntime(cliPath);
      await verifyChain();
      const result = await invoke(['wallet', 'list', '--type', 'local', '--chain', 'ARC', '--output', 'json']);
      if (result.code !== 0 || result.interrupted) throw problem('CIRCLE_NOT_READY', 'Circle local wallet access is not ready. Review terms and local wallet setup.');
      const payload = JSON.parse(result.stdout);
      const wallets = payload.data?.wallets;
      if (!Array.isArray(wallets) || accounts.some(account => !wallets.some(wallet => wallet.type === 'local' && wallet.blockchain === 'ARC' && typeof wallet.address === 'string' && same(wallet.address, account)))) {
        throw problem('CIRCLE_ACCOUNT_UNAVAILABLE', 'A configured account is not in the isolated local Circle vault.');
      }
      return { ready: true, ...identity(), upstreamVersion: manifest.upstreamVersion };
    } catch (error) { return { ready: false, code: error.code ?? 'CIRCLE_NOT_READY', message: error.code ? error.message : 'Circle local preflight failed.' }; }
  }
  function identity() { return { kind: 'circle-local', mode: 'patched-cli-local-fork', chainId, accounts: [...accounts], hostedCircleValidated: false }; }
  async function execute(tx) {
    let args;
    let approved;
    try {
      if (!tx || tx.chainId !== chainId || typeof tx.account !== 'string' || !accounts.some(item => same(item, tx.account)) || !address.test(tx.to ?? '')
        || typeof tx.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(tx.operationId)) throw problem('CIRCLE_INVALID_TRANSACTION', 'Transaction identity does not match the configured executor.');
      const value = decimal(tx.value ?? '0');
      const nonce = decimal(Number.isSafeInteger(tx.nonce) && tx.nonce >= 0 ? String(tx.nonce) : tx.nonce);
      const gas = decimal(tx.gas);
      const maxFee = decimal(tx.maxFeePerGas);
      const priorityFee = decimal(tx.maxPriorityFeePerGas ?? '0');
      if (BigInt(gas) === 0n || BigInt(maxFee) === 0n || BigInt(priorityFee) > BigInt(maxFee)) throw problem('CIRCLE_INVALID_TRANSACTION', 'An explicit positive gas and fee envelope is required.');
      const call = circleArguments(tx.data, tx.abi ?? abis);
      approved = Object.freeze({ ...tx, value, nonce, gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: priorityFee });
      args = ['wallet', 'execute', call.signature, ...call.parameters, '--address', tx.account, '--contract', tx.to,
        '--chain', 'ARC', '--rpc-url', endpoint.href, '--amount', formatUnits(BigInt(value), 18), '--idempotency-key', tx.operationId,
        '--argus-nonce', nonce, '--argus-gas', gas, '--argus-max-fee-per-gas', maxFee, '--argus-max-priority-fee-per-gas', priorityFee, '--output', 'json'];
      const ready = await preflight();
      if (!ready.ready) throw problem(ready.code, ready.message);
      if (await authorize(approved) !== true) throw problem('CIRCLE_NOT_AUTHORIZED', 'This exact saved action has not been authorized.');
    } catch (error) { return { status: 'rejected', code: error.code ?? 'CIRCLE_VALIDATION_FAILED', message: error.code ? error.message : 'Circle transaction validation failed.' }; }
    // After spawn, a failed/timeout process may already have broadcast. Never automatically retry.
    try {
      const result = await invoke(args);
      if (result.code !== 0 || result.interrupted) return { status: 'unknown', code: 'CIRCLE_SUBMISSION_UNKNOWN' };
      const data = JSON.parse(result.stdout).data;
      if (!data || !hash.test(data.txHash ?? '') || data.blockchain !== 'ARC' || !same(data.sourceAddress ?? '', approved.account)
        || !same(data.destinationAddress ?? data.contractAddress ?? '', approved.to)) return { status: 'unknown', code: 'CIRCLE_SUBMISSION_UNKNOWN' };
      return { status: 'submitted', hash: data.txHash };
    } catch { return { status: 'unknown', code: 'CIRCLE_SUBMISSION_UNKNOWN' }; }
  }
  async function lookup({ hash: transactionHash, providerId } = {}) {
    if (!hash.test(transactionHash ?? '') || providerId) return { status: 'unknown' };
    try {
      await verifyChain();
      const [receipt, transaction] = await Promise.all([rpc('eth_getTransactionReceipt', [transactionHash]), rpc('eth_getTransactionByHash', [transactionHash])]);
      if (receipt && same(receipt.transactionHash ?? '', transactionHash) && ['0x0', '0x1'].includes(receipt.status)) {
        return { status: receipt.status === '0x1' ? 'confirmed' : 'reverted', hash: transactionHash, receipt, transaction };
      }
      return { status: transaction ? 'pending' : 'unknown', hash: transactionHash, transaction };
    } catch { return { status: 'unknown', hash: transactionHash }; }
  }
  return { identity, preflight, execute, lookup };
}
