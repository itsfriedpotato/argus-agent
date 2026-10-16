import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { decodeFunctionData, encodeFunctionData, formatUnits, keccak256 } from 'viem';
import { hostedUpstream, patchHostedSource } from './patch-circle-hosted.mjs';

const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const providerUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const problem = (code, message) => Object.assign(new Error(message), { code });
const digest = value => createHash('sha256').update(value).digest('hex');

export function verifyCircleHostedRuntime(cliPath) {
  try {
    const root = dirname(cliPath);
    const manifest = JSON.parse(readFileSync(join(root, 'hosted-patch.json'), 'utf8'));
    const packageInfo = JSON.parse(readFileSync(join(root, 'node_modules/@circle-fin/cli/package.json'), 'utf8'));
    const original = readFileSync(join(root, 'node_modules/@circle-fin/cli/dist/index.js'), 'utf8');
    const expected = digest(patchHostedSource(original));
    if (packageInfo.name !== hostedUpstream.package || packageInfo.version !== hostedUpstream.version
      || manifest.patchId !== 'argus-hosted-calldata-v1' || manifest.upstreamVersion !== hostedUpstream.version
      || manifest.upstreamSha256 !== hostedUpstream.sha256 || manifest.hostedOnly !== true
      || manifest.patchedSha256 !== expected || digest(readFileSync(cliPath)) !== expected) throw new Error('Runtime mismatch');
    return { version: hostedUpstream.version, sha256: expected };
  } catch { throw problem('CIRCLE_RUNTIME_MISMATCH', 'Pinned hosted Circle transport failed provenance verification.'); }
}

function childRun(path, args, { env, timeoutMs }) {
  return new Promise(resolveResult => {
    execFile(process.execPath, [path, ...args], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolveResult({ code: error ? error.code : 0, stdout, interrupted: Boolean(error?.killed || error?.signal) });
    });
  });
}

function exactCalldata(data, abis) {
  if (typeof data !== 'string' || data.length > 262146 || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(data)) throw problem('CIRCLE_INVALID_CALLDATA', 'An ABI-encoded contract call is required.');
  for (const item of abis.flat(Infinity).filter(item => item?.type === 'function')) {
    try {
      const decoded = decodeFunctionData({ abi: [item], data });
      if (same(encodeFunctionData({ abi: [item], functionName: item.name, args: decoded.args ?? [] }), data)) return;
    } catch { /* Try only configured ABI items; no guessed signatures. */ }
  }
  throw problem('CIRCLE_UNSUPPORTED_ABI', 'No configured ABI reproduces the exact transaction calldata.');
}

/** Hosted MPC transport. Estimates are not an enforceable gas or total-spend ceiling. */
export function createCircleHostedExecutor({ cliPath, cliHome, accounts, abis = [], authorize, timeoutMs = 180_000, run = childRun } = {}) {
  if (![cliPath, cliHome].every(path => typeof path === 'string' && isAbsolute(path))
    || !Array.isArray(accounts) || !accounts.length || accounts.some(value => !address.test(value))
    || typeof authorize !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw problem('CIRCLE_CONFIGURATION', 'Configure absolute runtime/session paths, permitted accounts, an authorizer and a bounded timeout.');
  }
  accounts = Object.freeze([...accounts]);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', CIRCLE_CLI_HOME: cliHome, CIRCLE_VERSION_CHECK: 'off', DO_NOT_TRACK: '1' };
  const invoke = args => run(cliPath, args, { env: { ...env }, timeoutMs });
  const identity = () => ({ kind: 'circle-hosted', mode: 'derived-cli-hosted-calldata', chainId: 5042, accounts: [...accounts],
    feeMode: 'circle-medium', exactFeeCeiling: false, signer: 'hosted-circle-agent-sca' });
  function transaction(tx) {
    if (!tx || tx.chainId !== 5042 || !accounts.some(account => same(account, tx.account)) || !address.test(tx.to ?? '')
      || !uuid.test(tx.operationId ?? '')) throw problem('CIRCLE_INVALID_TRANSACTION', 'Transaction identity or UUIDv4 operation ID is invalid.');
    if (['gas', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasPrice', 'nonce'].some(key => tx[key] !== undefined)
      || tx.exactFeeCeiling === true) throw problem('CIRCLE_FEE_ENVELOPE_UNSUPPORTED', 'Hosted Circle MEDIUM fees do not enforce an exact gas, fee or nonce envelope.');
    const value = typeof tx.value === 'bigint' ? tx.value.toString() : tx.value ?? '0';
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n) throw problem('CIRCLE_INVALID_TRANSACTION', 'Native value must be an exact non-negative integer string.');
    exactCalldata(tx.data, tx.abi ?? abis);
    return Object.freeze({ account: tx.account, to: tx.to, data: tx.data, value, chainId: 5042, operationId: tx.operationId,
      calldataHash: keccak256(tx.data), feeMode: 'circle-medium', exactFeeCeiling: false });
  }
  function command(tx, estimateOnly) {
    return ['wallet', 'execute', '--call-data', tx.data, '--address', tx.account, '--contract', tx.to, '--chain', 'ARC',
      '--amount', formatUnits(BigInt(tx.value), 18), '--idempotency-key', tx.operationId, ...(estimateOnly ? ['--estimate'] : []), '--output', 'json'];
  }
  async function preflight() {
    try {
      const runtime = verifyCircleHostedRuntime(cliPath);
      const result = await invoke(['wallet', 'list', '--type', 'agent', '--chain', 'ARC', '--output', 'json']);
      if (result.code !== 0 || result.interrupted) throw problem('CIRCLE_NOT_READY', 'Hosted Circle wallet access is not ready.');
      const wallets = JSON.parse(result.stdout).data?.wallets;
      if (!Array.isArray(wallets) || accounts.some(account => !wallets.some(wallet => wallet.type === 'agent'
        && wallet.blockchain === 'ARC' && same(wallet.address, account)))) throw problem('CIRCLE_ACCOUNT_UNAVAILABLE', 'A configured hosted ARC account is unavailable.');
      return { ready: true, ...identity(), runtime };
    } catch (error) { return { ready: false, code: error.code ?? 'CIRCLE_NOT_READY', message: error.code ? error.message : 'Circle preflight failed.' }; }
  }
  async function requireReady() {
    const result = await preflight();
    if (!result.ready) throw problem(result.code, result.message);
  }
  async function estimate(input) {
    try {
      const tx = transaction(input);
      await requireReady();
      const result = await invoke(command(tx, true));
      if (result.code !== 0 || result.interrupted) throw problem('CIRCLE_ESTIMATE_FAILED', 'Circle could not estimate this action.');
      const payload = JSON.parse(result.stdout).data;
      const medium = payload?.medium;
      if (payload?.blockchain !== 'ARC' || !medium || typeof medium.networkFee !== 'string'
        || !/^\d+(\.\d+)?$/.test(medium.networkFee)) throw problem('CIRCLE_ESTIMATE_FAILED', 'Circle returned an invalid fee estimate.');
      const fees = {};
      for (const key of ['gasLimit', 'networkFee', 'networkFeeRaw', 'baseFee', 'priorityFee', 'maxFee']) {
        if (typeof medium[key] === 'string' && /^\d+(\.\d+)?$/.test(medium[key])) fees[key] = medium[key];
      }
      for (const key of ['callGasLimit', 'verificationGasLimit', 'preVerificationGas']) {
        if (typeof payload[key] === 'string' && /^\d+$/.test(payload[key])) fees[key] = payload[key];
      }
      return { ok: true, chainId: 5042, account: tx.account, calldataHash: tx.calldataHash, feeMode: 'circle-medium', exactFeeCeiling: false, fees };
    } catch (error) { return { ok: false, code: error.code ?? 'CIRCLE_ESTIMATE_FAILED', message: error.code ? error.message : 'Circle estimate failed.' }; }
  }
  async function execute(input) {
    let tx;
    try {
      tx = transaction(input);
      await requireReady();
      if (await authorize(tx) !== true) throw problem('CIRCLE_NOT_AUTHORIZED', 'This exact saved action has not been authorized.');
    } catch (error) { return { status: 'rejected', code: error.code ?? 'CIRCLE_VALIDATION_FAILED', message: error.code ? error.message : 'Circle transaction validation failed.' }; }
    // The caller must durably reserve this UUID and approved payload before authorizing.
    // After spawn, every ambiguous outcome retains that reservation; never retry here.
    const pending = { status: 'unknown', code: 'CIRCLE_SUBMISSION_UNKNOWN', idempotencyKey: tx.operationId };
    try {
      const result = await invoke(command(tx, false));
      if (result.code !== 0 || result.interrupted) return pending;
      const payload = JSON.parse(result.stdout).data;
      const destinations = [payload?.contractAddress, payload?.destinationAddress].filter(value => value !== undefined && value !== null);
      if (!payload || !providerUuid.test(payload.id ?? '') || payload.idempotencyKey !== tx.operationId
        || !['CONFIRMED', 'COMPLETE'].includes(payload.state) || !hash.test(payload.txHash ?? '')
        || payload.blockchain !== 'ARC' || !same(payload.sourceAddress, tx.account)
        || !destinations.length || destinations.some(value => !same(value, tx.to))) return pending;
      return { status: 'submitted', hash: payload.txHash, providerId: payload.id, idempotencyKey: tx.operationId,
        providerState: payload.state, exactFeeCeiling: false };
    } catch { return pending; }
  }
  async function lookup({ providerId, hash: transactionHash, account, idempotencyKey, to, data } = {}) {
    if (!accounts.some(value => same(value, account))
      || (providerId !== undefined && !providerUuid.test(providerId)) || (transactionHash !== undefined && !hash.test(transactionHash))
      || (idempotencyKey !== undefined && !uuid.test(idempotencyKey)) || (to !== undefined && !address.test(to))
      || (data !== undefined && (typeof data !== 'string' || !/^0x(?:[\da-f]{2}){4,}$/i.test(data)))) return { status: 'unknown' };
    if (!providerId && !transactionHash) {
      // Circle 1.1.4's history formatter omits the original idempotency key
      // and raw calldata. An attempt UUID cannot identify a history entry.
      return idempotencyKey ? { status: 'unknown', code: 'CIRCLE_IDEMPOTENCY_LOOKUP_UNAVAILABLE',
        recovery: 'Supply the transaction hash for independent verification against the saved action. Do not submit another transaction.' }
        : { status: 'unknown' };
    }
    try {
      await requireReady();
      const result = await invoke(['transaction', 'list', '--address', account, '--chain', 'ARC', '--operation', 'execute', '--limit', '100', '--output', 'json']);
      if (result.code !== 0 || result.interrupted) return { status: 'unknown' };
      const transactions = JSON.parse(result.stdout).data?.transactions;
      if (!Array.isArray(transactions)) return { status: 'unknown' };
      const matches = transactions.filter(tx => {
        const destinations = [tx.contractAddress, tx.destinationAddress].filter(value => value !== undefined && value !== null);
        const calldata = [tx.callData, tx.data].filter(value => value !== undefined && value !== null);
        return providerUuid.test(tx.id ?? '') && tx.blockchain === 'ARC' && same(tx.sourceAddress, account)
          && (!providerId || same(tx.id, providerId)) && (!transactionHash || same(tx.txHash, transactionHash))
          && destinations.length > 0 && destinations.every(value => address.test(value) && same(value, destinations[0]) && (!to || same(value, to)))
          && (!data || calldata.every(value => same(value, data)));
      });
      if (matches.length !== 1) return { status: 'unknown' };
      const tx = matches[0];
      const status = ['CONFIRMED', 'COMPLETE'].includes(tx.state) ? 'confirmed'
        : ['FAILED', 'CANCELLED', 'DENIED'].includes(tx.state) ? 'failed' : 'pending';
      if (status === 'confirmed' && !hash.test(tx.txHash ?? '')) return { status: 'unknown' };
      return { status, providerId: tx.id, ...(hash.test(tx.txHash ?? '') ? { hash: tx.txHash } : {}), providerState: tx.state,
        chainId: 5042, account, contractAddress: tx.contractAddress ?? tx.destinationAddress,
        // Provider state is not an on-chain SCA calldata/effects verification.
        onchainVerified: false };
    } catch { return { status: 'unknown' }; }
  }
  return { identity, preflight, estimate, execute, lookup };
}
