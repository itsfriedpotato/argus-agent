import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { encodeFunctionData, parseAbi, toFunctionSignature } from 'viem';
import { patchHostedSource, hostedUpstream } from '../scripts/argus-agent/patch-circle-hosted.mjs';
import { createCircleHostedExecutor } from '../scripts/argus-agent/circle-hosted-executor.mjs';

const upstreamPath = resolve('.cache/argus-agent/circle-runtime/node_modules/@circle-fin/cli/dist/index.js');
const upstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf8') : null;
const source = upstream ? patchHostedSource(upstream) : null;
const skip = source ? false : 'Pinned official Circle runtime is not cached';
const operator = '0x1111111111111111111111111111111111111111';
const contract = '0x2222222222222222222222222222222222222222';
const operationId = '12345678-1234-4234-9234-123456789abc';
const abi = parseAbi(['function launch((string name,uint256 seed,(address to,uint128 amount)[] buy,(string image,string description) meta) settings,bytes32 salt)']);
const data = encodeFunctionData({ abi, functionName: 'launch', args: [['Argus "tuple"', 2n ** 100n, [[operator, 4500000n]], ['https://argus.world/avatars/arc-023.png', 'Exact metadata']], `0x${'01'.repeat(32)}`] });

function fixture(runtime = source) {
  const calls = [];
  const errors = [];
  const outputs = [];
  const state = { type: 'agent' };
  const context = vm.createContext({
    process: { exitCode: 0, stdout: { write() {} } },
    requireFlags: args => ({ '--address': operator, '--chain': args[args.indexOf('--chain') + 1], '--contract': contract }),
    resolveOrReport: async () => ({ wallet: { type: state.type, address: operator, walletId: 'wallet-id' }, env: { userToken: 'test-only-token' } }),
    getProxyUrl: () => 'https://circle.example', CircleHttpClient: class {},
    estimateAgentContractExecutionFee: async (_client, _token, wallet, request) => { calls.push({ kind: 'estimate', wallet, request }); return { medium: { networkFee: '0.02' } }; },
    submitAgentContractExecutionChallenge: async (_client, _token, wallet, request) => { calls.push({ kind: 'create', wallet, request }); return { challengeId: 'challenge-id', idempotencyKey: request.idempotencyKey }; },
    runTransactionChallenge: async (...args) => { calls.push({ kind: 'approve', challengeId: args[3] }); return { id: 'provider-id', state: 'COMPLETE' }; },
    pickSubmittedFee: value => value, parseOutputFormat: () => 'json',
    output: value => outputs.push(value), outputError: (message, _args, code) => errors.push({ message, code }),
    handleLocalExecuteEstimate: async () => calls.push({ kind: 'local-estimate' }),
    handleLocalExecute: async () => calls.push({ kind: 'local-execute' }), emitLocalWalletControlsWarning() {},
  });
  const parserStart = runtime.indexOf('function positionalArgs(args2) {');
  const parserEnd = runtime.indexOf('\nfunction ', runtime.indexOf('function readFlagValue(', parserStart) + 1);
  vm.runInContext(runtime.slice(parserStart, parserEnd), context);
  const commandStart = runtime.indexOf('async function walletExecuteCommand(');
  const commandEnd = runtime.indexOf('async function handleLocalExecuteEstimate(', commandStart);
  vm.runInContext(runtime.slice(commandStart, commandEnd), context);
  return { calls, errors, outputs, state, run: async args => { context.args = args; await vm.runInContext('walletExecuteCommand({}, args)', context); } };
}

test('hosted patch requires the exact official package source', () => {
  assert.equal(hostedUpstream.version, '1.1.4');
  assert.throws(() => patchHostedSource('// changed source'), /unmodified official/);
});

test('stock hosted command transports a tuple as a string, not a structured ABI array', { skip }, async () => {
  const f = fixture(upstream);
  const parameter = JSON.stringify(['name', '1', [[operator, '1']], ['image', 'description']]);
  await f.run([toFunctionSignature(abi[0]), parameter, `0x${'01'.repeat(32)}`, '--chain', 'ARC', '--estimate']);
  assert.equal(f.calls[0].request.abiParameters[0], parameter);
  assert.equal(typeof f.calls[0].request.abiParameters[0], 'string');
});

test('raw hosted estimate preserves every calldata byte and never creates or approves a challenge', { skip }, async () => {
  const f = fixture();
  await f.run(['--call-data', data, '--chain', 'ARC', '--estimate']);
  assert.deepEqual(f.calls.map(call => call.kind), ['estimate']);
  assert.equal(f.calls[0].request.callData, data);
  assert.equal(Object.hasOwn(f.calls[0].request, 'abiFunctionSignature'), false);
  assert.equal(Object.hasOwn(f.calls[0].request, 'abiParameters'), false);
  assert.equal(f.outputs[0].medium.networkFee, '0.02');
  assert.equal(f.errors.length, 0);
});

test('raw hosted request retains value, idempotency and the normal approval cycle', { skip }, async () => {
  const f = fixture();
  await f.run(['--call-data', data, '--chain', 'ARC', '--amount', '0.25', '--idempotency-key', operationId]);
  assert.deepEqual(f.calls.map(call => call.kind), ['create', 'approve']);
  assert.equal(f.calls[0].request.callData, data);
  assert.equal(f.calls[0].request.idempotencyKey, operationId);
  assert.equal(f.calls[0].request.amount, '0.25');
  assert.equal(Object.hasOwn(f.calls[0].request, 'abiParameters'), false);
  assert.equal(f.calls[1].challengeId, 'challenge-id');
});

test('raw mode rejects ambiguous, malformed, non-Arc and local-wallet requests before provider access', { skip }, async () => {
  for (const args of [
    ['--call-data', data, 'approve(address,uint256)', '--chain', 'ARC'],
    ['--call-data', data, '--call-data', data, '--chain', 'ARC'],
    ['--call-data', '--chain', 'ARC'],
    ['--call-data', '0x123', '--chain', 'ARC'],
    ['--call-data', '0xzzzzzzzz', '--chain', 'ARC'],
    ['--call-data', data, '--chain', 'BASE'],
  ]) {
    const f = fixture(); await f.run(args);
    assert.equal(f.calls.length, 0); assert.equal(f.errors[0].code, 'INVALID_ARGUMENT');
  }
  const f = fixture(); f.state.type = 'local';
  await f.run(['--call-data', data, '--chain', 'ARC', '--estimate']);
  assert.equal(f.calls.length, 0); assert.match(f.errors[0].message, /hosted Circle/);
});

test('ordinary scalar ABI and local command behavior remain unchanged', { skip }, async () => {
  const f = fixture();
  await f.run(['approve(address,uint256)', contract, '4500000', '--chain', 'ARC', '--estimate']);
  assert.equal(f.calls[0].request.abiFunctionSignature, 'approve(address,uint256)');
  assert.deepEqual(Array.from(f.calls[0].request.abiParameters), [contract, '4500000']);
  assert.equal(Object.hasOwn(f.calls[0].request, 'callData'), false);
  f.state.type = 'local';
  await f.run(['approve(address,uint256)', contract, '4500000', '--chain', 'ARC', '--estimate']);
  assert.equal(f.calls[1].kind, 'local-estimate');
});

test('hosted auth, service request helper and MEDIUM fee selection are untouched', { skip }, () => {
  for (const [start, end] of [
    ['  async createContractExecutionChallenge(', '\n  // POST /v1/w3s/user/transactions/contractDeployment.'],
    ['  async executeChallenge(challengeId, userToken,', '\n  // Internal: send request through proxy to SDK API'],
    ['async function runTransactionChallenge(', '\nfunction formatTransactionOutput('],
  ]) {
    const extract = value => value.slice(value.indexOf(start), value.indexOf(end, value.indexOf(start)));
    assert.ok(extract(upstream)); assert.equal(extract(source), extract(upstream));
  }
});

test('pinned Circle history omits idempotency keys and calldata even when supplied in a provider record', { skip }, () => {
  const start = upstream.indexOf('function formatTransactionOutput(tx, idempotencyKey) {');
  const end = upstream.indexOf('\nfunction pickSubmittedFee(', start);
  const context = vm.createContext({ transaction: { id: 'provider-id', idempotencyKey: operationId, callData: data } });
  vm.runInContext(upstream.slice(start, end), context);
  const history = vm.runInContext('formatTransactionOutput(transaction)', context);
  assert.equal(Object.hasOwn(history, 'idempotencyKey'), false);
  assert.equal(Object.hasOwn(history, 'callData'), false);
  assert.ok(upstream.includes('transactions: transactions.map((tx) => formatTransactionOutput(tx))'));
});

const hostedPath = resolve('.cache/argus-agent/circle-runtime/circle-hosted.mjs');
const adapterSkip = existsSync(hostedPath) ? false : 'Build the pinned hosted transport before adapter tests';
// Circle returns version-5 provider IDs; caller idempotency remains UUIDv4.
const providerId = '0b780175-211a-5131-8b65-9024bac73f7d';
const txHash = `0x${'ab'.repeat(32)}`;
const txInput = () => ({ account: operator, to: contract, data, value: '0', chainId: 5042, operationId, abi });

function adapterFixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'argus-hosted-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const approved = [];
  const state = { authorized: true, wallets: [{ type: 'agent', address: operator, blockchain: 'ARC' }],
    response: { data: { id: providerId, idempotencyKey: operationId, state: 'COMPLETE', txHash,
      blockchain: 'ARC', sourceAddress: operator, contractAddress: contract } },
    fee: { data: { blockchain: 'ARC', medium: { networkFee: '0.025', maxFee: '49.1', gasLimit: '500000' }, callGasLimit: '70000' } },
    transactions: [], code: 0, interrupted: false };
  const config = { cliPath: hostedPath, cliHome: join(dir, 'session'), accounts: [operator],
    authorize: async tx => { approved.push(tx); return state.authorized; },
    run: async (path, args, options) => {
      calls.push({ path, args, options });
      if (args[0] === 'wallet' && args[1] === 'list') return { code: 0, stdout: JSON.stringify({ data: { wallets: state.wallets } }) };
      if (args[0] === 'transaction') return { code: 0, stdout: JSON.stringify({ data: { transactions: state.transactions } }) };
      return { code: state.code, interrupted: state.interrupted, stdout: typeof state.response === 'string' ? state.response : JSON.stringify(args.includes('--estimate') ? state.fee : state.response) };
    }, ...overrides };
  return { executor: createCircleHostedExecutor(config), config, state, calls, approved, dir };
}

test('hosted adapter proves runtime and agent identity while forwarding only its explicit environment', { skip: adapterSkip }, async t => {
  const f = adapterFixture(t);
  assert.equal((await f.executor.preflight()).ready, true);
  assert.deepEqual(Object.keys(f.calls[0].options.env).sort(), ['CIRCLE_CLI_HOME', 'CIRCLE_VERSION_CHECK', 'DO_NOT_TRACK', 'PATH']);
  assert.equal(f.executor.identity().exactFeeCeiling, false);
  const wrongPath = join(f.dir, 'tampered.mjs'); writeFileSync(wrongPath, '// tampered');
  const changed = createCircleHostedExecutor({ ...f.config, cliPath: wrongPath });
  assert.equal((await changed.execute(txInput())).code, 'CIRCLE_RUNTIME_MISMATCH');
  assert.equal(f.calls.length, 1);
  f.state.wallets[0].type = 'local';
  assert.equal((await f.executor.preflight()).code, 'CIRCLE_ACCOUNT_UNAVAILABLE');
});

test('hosted adapter estimate is read-only and explicitly reports an unenforced fee quote', { skip: adapterSkip }, async t => {
  const f = adapterFixture(t);
  const result = await f.executor.estimate(txInput());
  assert.equal(result.ok, true); assert.equal(result.exactFeeCeiling, false);
  assert.equal(result.fees.networkFee, '0.025'); assert.equal(result.fees.callGasLimit, '70000');
  assert.equal(f.approved.length, 0);
  assert.ok(f.calls[1].args.includes('--estimate'));
  assert.equal(f.calls[1].args[f.calls[1].args.indexOf('--call-data') + 1], data);
});

test('hosted adapter authorizes frozen exact calldata and captures UUID before execution', { skip: adapterSkip }, async t => {
  const f = adapterFixture(t);
  const result = await f.executor.execute(txInput());
  assert.equal(result.status, 'submitted'); assert.equal(result.providerId, providerId);
  assert.equal(result.idempotencyKey, operationId);
  assert.equal(f.approved[0].data, data); assert.ok(Object.isFrozen(f.approved[0]));
  assert.equal(f.approved[0].exactFeeCeiling, false);
  const args = f.calls[1].args;
  assert.equal(args[args.indexOf('--idempotency-key') + 1], operationId);
  assert.equal(args[args.indexOf('--call-data') + 1], data);
  assert.equal(args.includes('--estimate'), false);
});

test('absent optional destination does not reject a matching contract address', { skip: adapterSkip }, async t => {
  const f = adapterFixture(t);
  f.state.response.data.destinationAddress = null;
  assert.equal((await f.executor.execute(txInput())).status, 'submitted');
  f.state.response.data.contractAddress = null;
  assert.equal((await f.executor.execute(txInput())).status, 'unknown');
});

test('hosted adapter rejects authorization, incorrect ABI and unsupported exact envelopes before send', { skip: adapterSkip }, async t => {
  const f = adapterFixture(t); f.state.authorized = false;
  assert.equal((await f.executor.execute(txInput())).code, 'CIRCLE_NOT_AUTHORIZED');
  assert.equal(f.calls.length, 1);
  for (const input of [
    { ...txInput(), gas: '100000' }, { ...txInput(), nonce: 0 }, { ...txInput(), maxFeePerGas: '1' },
    { ...txInput(), maxPriorityFeePerGas: '1' }, { ...txInput(), exactFeeCeiling: true },
  ]) assert.equal((await f.executor.execute(input)).code, 'CIRCLE_FEE_ENVELOPE_UNSUPPORTED');
  assert.equal((await f.executor.execute({ ...txInput(), data: `${data}00` })).code, 'CIRCLE_UNSUPPORTED_ABI');
  assert.equal((await f.executor.execute({ ...txInput(), operationId: 'not-a-uuid' })).code, 'CIRCLE_INVALID_TRANSACTION');
  assert.equal((await f.executor.execute({ ...txInput(), chainId: 1 })).code, 'CIRCLE_INVALID_TRANSACTION');
  assert.equal(f.calls.length, 1);
});

test('hosted timeouts, malformed output and conflicting provider fields retain unknown outcome without retry', { skip: adapterSkip }, async t => {
  for (const patch of [
    { code: 1 }, { interrupted: true }, { response: 'not JSON' },
    { responseField: ['sourceAddress', contract] }, { responseField: ['contractAddress', operator] },
    { responseField: ['destinationAddress', operator] }, { responseField: ['blockchain', 'BASE'] },
    { responseField: ['idempotencyKey', providerId] }, { responseField: ['id', 'invalid'] },
  ]) {
    const f = adapterFixture(t);
    if (patch.responseField) f.state.response.data[patch.responseField[0]] = patch.responseField[1];
    else Object.assign(f.state, patch);
    const result = await f.executor.execute(txInput());
    assert.equal(result.status, 'unknown'); assert.equal(result.idempotencyKey, operationId);
    assert.equal(f.calls.filter(call => call.args[1] === 'execute').length, 1);
  }
});

test('hosted lookup only reconciles a unique matching provider transaction and never marks SCA calldata verified', { skip: adapterSkip }, async t => {
  const f = adapterFixture(t); f.state.transactions = [f.state.response.data];
  const result = await f.executor.lookup({ account: operator, providerId, hash: txHash });
  assert.equal(result.status, 'confirmed'); assert.equal(result.onchainVerified, false);
  assert.equal(f.calls.some(call => call.args[1] === 'execute'), false);
  f.state.transactions[0].sourceAddress = contract;
  assert.equal((await f.executor.lookup({ account: operator, providerId })).status, 'unknown');
  f.state.transactions[0].sourceAddress = operator;
  f.state.transactions.push(f.state.transactions[0]);
  assert.equal((await f.executor.lookup({ account: operator, providerId })).status, 'unknown');
});

test('a lost response attempt UUID reports explicit hash recovery instead of guessing a provider transaction', { skip: adapterSkip }, async t => {
  const f = adapterFixture(t);
  f.state.transactions = [f.state.response.data];
  const result = await f.executor.lookup({ account: operator, idempotencyKey: operationId, to: contract, data });
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'CIRCLE_IDEMPOTENCY_LOOKUP_UNAVAILABLE');
  assert.match(result.recovery, /transaction hash/);
  assert.equal(f.calls.length, 0, 'the pinned history cannot answer this query');
  assert.equal((await f.executor.lookup({ account: operator, idempotencyKey: 'invalid' })).status, 'unknown');
  assert.equal(f.calls.length, 0);
});

test('known hash recovery is scoped to a unique provider wallet, chain and contract and checks any returned calldata', { skip: adapterSkip }, async t => {
  const f = adapterFixture(t);
  const input = { account: operator, hash: txHash, to: contract, data };
  f.state.transactions = [{ ...f.state.response.data }];
  const result = await f.executor.lookup(input);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.onchainVerified, false, 'provider metadata cannot prove calldata omitted by the CLI');
  for (const patch of [
    { id: 'invalid' }, { sourceAddress: contract }, { blockchain: 'BASE' },
    { contractAddress: operator }, { destinationAddress: operator },
    { contractAddress: null, destinationAddress: null }, { callData: '0x12345678' }, { data: '0x12345678' },
  ]) {
    f.state.transactions = [{ ...f.state.response.data, ...patch }];
    assert.equal((await f.executor.lookup(input)).status, 'unknown');
  }
  f.state.transactions = [{ ...f.state.response.data, callData: data }, { ...f.state.response.data, callData: data }];
  assert.equal((await f.executor.lookup(input)).status, 'unknown');
  assert.equal(f.calls.some(call => call.args[1] === 'execute'), false);
});
