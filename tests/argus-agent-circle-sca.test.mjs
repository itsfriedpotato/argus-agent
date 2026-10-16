import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { pacedReads } from '../scripts/argus-agent/rpc-reads.mjs';
import { buildAtomicBatch, CIRCLE_BATCH_ABI, CIRCLE_BATCH_SELECTOR } from '../scripts/argus-agent/batch.mjs';
import { CIRCLE_SCA_DEPLOYMENT as D, packedUserOperationHash, verifyCircleSCAReceipt } from '../scripts/argus-agent/circle-sca-receipts.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/circle-sca-approval.json', import.meta.url), 'utf8'));
const bigintFields = new Set(['blockNumber', 'number', 'timestamp', 'gas', 'gasUsed', 'effectiveGasPrice', 'baseFeePerGas', 'value', 'maxFeePerGas', 'maxPriorityFeePerGas']);
const walletAbi = parseAbi(['function execute(address target,uint256 value,bytes data) returns(bytes)']);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
function setup() {
  const state = JSON.parse(JSON.stringify(fixture), (key, value) => bigintFields.has(key) && typeof value === 'string' ? BigInt(value) : value);
  const bundle = decodeFunctionData({ abi: entryPoint07Abi, data: state.transaction.input });
  const op = bundle.args[0][0];
  const inner = decodeFunctionData({ abi: walletAbi, data: op.callData });
  const calls = [];
  state.plugins = []; state.executionHooks = []; state.validationHooks = [[], []]; state.priorCode = '0x';
  state.slot = `0x${'0'.repeat(24)}${D.implementation.slice(2)}`;
  state.balanceBefore = 9900000000000000000n; state.balanceAfter = state.balanceBefore; state.sponsorLogs = [];
  const step = { from: op.sender, to: inner.args[0], value: inner.args[1].toString(), data: inner.args[2], principalRaw: '0',
    attempt: { id: '12345678-1234-4234-9234-123456789abc', from: op.sender, blockNumber: (state.receipt.blockNumber - 1n).toString(),
      startedAt: new Date(Number(state.block.timestamp - 5n) * 1000).toISOString() } };
  const action = { metadata: { preparedAtBlock: step.attempt.blockNumber } };
  const client = {
    getChainId: async () => state.transaction.chainId,
    getTransaction: async () => state.transaction, getTransactionReceipt: async () => state.receipt, getBlock: async () => state.block,
    getCode: async request => {
      calls.push({ method: 'getCode', ...request });
      if (same(request.address, D.entryPoint)) return state.entryPointCode;
      if (same(request.address, D.implementation)) return state.implementationCode;
      if (same(request.address, D.factory)) return state.factoryCode;
      if (same(request.address, D.paymaster)) return state.paymasterCode;
      if (same(request.address, D.paymasterImplementation)) return state.paymasterImplementationCode;
      if (same(request.address, step.from)) return request.blockNumber < state.receipt.blockNumber ? state.priorCode : state.proxyCode;
      throw new Error('Unexpected code read');
    },
    getStorageAt: async request => same(request.address, D.paymaster) ? state.paymasterSlot ?? `0x${'0'.repeat(24)}${D.paymasterImplementation.slice(2)}` : state.slot,
    getLogs: async request => same(request.address, D.paymaster) ? state.sponsorLogs : state.walletBlockLogs ?? state.receipt.logs.filter(log => same(log.address, step.from)),
    getBalance: async request => request.blockNumber < state.receipt.blockNumber ? state.balanceBefore : state.balanceAfter,
    readContract: async request => {
      calls.push({ method: 'readContract', ...request });
      if (state.hooksBySelector?.[request.args?.[0]]?.[request.functionName]) return state.hooksBySelector[request.args[0]][request.functionName];
      return { getEntryPoint: D.entryPoint, getInstalledPlugins: state.plugins, getExecutionHooks: state.executionHooks,
        getPreValidationHooks: state.validationHooks, getAddress: op.sender, getNativeOwner: '0xcc8985de5939690626fe0645e38ebc86b20c0392' }[request.functionName];
    },
  };
  const run = () => verifyCircleSCAReceipt(client, { hash: fixture.transaction.hash, step, action, readIntervalMs: 0 });
  return { state, step, action, client, run, calls, op, bundle };
}

test('actual hosted approval fixture verifies exact packed operation, single wallet call and sponsored cost', async () => {
  const f = setup(); const result = await f.run();
  assert.equal(result.verified, true); assert.equal(result.state, 'confirmed');
  assert.equal(result.userOperationHash, '0xff16a3e1d650cd204d0757d3dba3c379c52ba1a089f82e6682fb2bf08db17821');
  assert.equal(result.networkFeeWei, '10456685218968930');
  assert.equal(result.feeAccounting, 'conservative-user-operation-cost'); assert.equal(result.paymasterUsed, true);
  assert.notEqual(result.networkFeeWei, (f.state.receipt.gasUsed * f.state.receipt.effectiveGasPrice).toString());
  assert.equal(result.exactSingleWalletCall, true); assert.equal(result.singleOperationBundle, true);
  assert.equal(result.walletGrossDebitWei, '0'); assert.equal(result.walletBlockDebitWei, '0');
  assert.equal(result.receipt, f.state.receipt); assert.equal(result.transaction, f.state.transaction);
});

test('receipt RPC work is serialized by the bounded read queue without dropping checks', async () => {
  const f = setup(); let active = 0; let peak = 0; let count = 0;
  const client = Object.fromEntries(Object.entries(f.client).map(([method, fn]) => [method, async (...args) => {
    active++; peak = Math.max(peak, active); count++;
    try { await new Promise(resolve => setTimeout(resolve, 1)); return await fn(...args); }
    finally { active--; }
  }]));
  const shared = pacedReads(client, 1);
  const [result] = await Promise.all([
    verifyCircleSCAReceipt(shared, { hash: fixture.transaction.hash, step: f.step, action: f.action, readIntervalMs: 1 }),
    shared.getChainId(), shared.getBlock(),
  ]);
  assert.equal(result.verified, true); assert.equal(peak, 1); assert.ok(count >= 27);
});

test('bootstrap can bind to the persisted attempt block and timestamp without optional preparation metadata', async () => {
  const f = setup(); f.action.metadata = {};
  assert.equal((await f.run()).verified, true);
  delete f.step.attempt.startedAt;
  await assert.rejects(f.run, /timestamp is required/);
});

test('a later operation requalifies the existing account before and after the execution block', async () => {
  const f = setup();
  f.state.priorCode = f.state.proxyCode;
  f.state.receipt.logs = f.state.receipt.logs.filter(log => !same(log.address, f.step.from));
  f.op.initCode = '0x';
  f.state.transaction.input = encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: f.bundle.args });
  const event = f.state.receipt.logs.find(log => log.topics[0] === '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f');
  event.topics[1] = packedUserOperationHash(f.op);
  assert.equal((await f.run()).verified, true);
  const checkedBlocks = f.calls.filter(call => call.functionName === 'getExecutionHooks').map(call => call.blockNumber);
  assert.deepEqual(checkedBlocks, [f.state.receipt.blockNumber, f.state.receipt.blockNumber - 1n]);
});

test('different sponsors, changed sponsor implementation and same-block sponsor events fail closed', async () => {
  for (const change of [
    f => { f.op.paymasterAndData = `${D.factory}${f.op.paymasterAndData.slice(42)}`; },
    f => { f.op.paymasterAndData = '0x'; },
    f => { f.state.paymasterCode = '0x00'; }, f => { f.state.paymasterImplementationCode = '0x00'; },
    f => { f.state.paymasterSlot = `0x${'00'.repeat(32)}`; }, f => { f.state.sponsorLogs = [{}]; },
  ]) {
    const f = setup(); change(f);
    f.state.transaction.input = encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: f.bundle.args });
    await assert.rejects(f.run, { code: 'ARGUS_SCA_RECEIPT_MISMATCH' });
  }
});

test('wallet events elsewhere in the same block, altered bootstrap events and unbound logs reject settlement', async () => {
  for (const change of [
    f => { f.state.walletBlockLogs = [...f.state.receipt.logs.filter(log => same(log.address, f.step.from)), { transactionHash: '0x00' }]; },
    f => { f.state.receipt.logs[0].topics[0] = `0x${'00'.repeat(32)}`; },
    f => { f.state.walletBlockLogs = f.state.receipt.logs.filter(log => same(log.address, f.step.from)).map(log => ({ ...log, blockHash: '0x00' })); },
  ]) { const f = setup(); change(f); await assert.rejects(f.run, { code: 'ARGUS_SCA_RECEIPT_MISMATCH' }); }
  const f = setup(); f.state.priorCode = f.state.proxyCode; f.op.initCode = '0x';
  f.state.transaction.input = encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: f.bundle.args });
  await assert.rejects(f.run, /Wallet changes or events/);
});

function addSystemTransfer(f, from, value) {
  const abi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  f.state.receipt.logs.push({ ...f.state.receipt.logs.at(-1), address: '0xfffffffffffffffffffffffffffffffffffffffe',
    logIndex: f.state.receipt.logs.at(-1).logIndex + 1,
    topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from, to: same(from, f.step.from) ? D.factory : f.step.from } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]) });
}

test('gross wallet debit is capped without netting receipts or counting ERC20 mirror transfers', async () => {
  const f = setup(); f.step.principalRaw = '4500000';
  const limit = 4500000n * 10n ** 12n + 10456685218968930n;
  addSystemTransfer(f, f.step.from, limit);
  // An ERC20 mirror represents the same principal and must not be counted a second time.
  f.state.receipt.logs.push({ ...f.state.receipt.logs.at(-1), address: '0x3600000000000000000000000000000000000000', logIndex: 12 });
  assert.equal((await f.run()).walletGrossDebitWei, limit.toString());
  addSystemTransfer(f, D.factory, limit * 2n); // even inbound flows never offset gross outflow
  addSystemTransfer(f, f.step.from, 1n);
  await assert.rejects(f.run, /Wallet USDC debit exceeds/);
});

test('unexplained wallet block debit and missing principal evidence fail closed', async () => {
  const f = setup(); f.state.balanceAfter -= 10456685218968931n;
  await assert.rejects(f.run, /Wallet USDC debit exceeds/);
  const missing = setup(); delete missing.step.principalRaw;
  await assert.rejects(missing.run, /saved principal/);
});

test('changed approved sender, destination, value, calldata and attempt sender reject the old receipt', async () => {
  for (const change of [
    f => { f.step.from = D.factory; }, f => { f.step.to = D.factory; }, f => { f.step.value = '1'; },
    f => { f.step.data = `${f.step.data}00`; }, f => { f.step.attempt.from = D.factory; },
  ]) { const f = setup(); change(f); await assert.rejects(f.run, { code: 'ARGUS_SCA_RECEIPT_MISMATCH' }); }
});

test('stale receipt, reorg and invalid canonical inclusion remain unresolved', async () => {
  for (const change of [
    f => { f.step.attempt.blockNumber = (f.state.receipt.blockNumber + 1n).toString(); },
    f => { f.action.metadata.preparedAtBlock = (f.state.receipt.blockNumber + 1n).toString(); },
    f => { f.step.attempt.startedAt = new Date(Number(f.state.block.timestamp + 20n) * 1000).toISOString(); },
    f => { f.state.block.hash = `0x${'11'.repeat(32)}`; },
    f => { f.state.block.transactions[f.state.receipt.transactionIndex] = `0x${'11'.repeat(32)}`; },
    f => { f.state.receipt.logs[0].removed = true; },
  ]) { const f = setup(); change(f); await assert.rejects(f.run, { code: 'ARGUS_SCA_RECEIPT_MISMATCH' }); }
});

test('wrong runtime, implementation pointer, plugin or execution hook rejects settlement', async () => {
  for (const change of [
    f => { f.state.entryPointCode = '0x00'; }, f => { f.state.implementationCode = '0x00'; },
    f => { f.state.proxyCode = '0x00'; }, f => { f.state.factoryCode = '0x00'; },
    f => { f.state.slot = `0x${'00'.repeat(32)}`; }, f => { f.state.plugins = [D.factory]; },
    f => { f.state.executionHooks = [{}]; }, f => { f.state.validationHooks = [[{}], []]; },
  ]) { const f = setup(); change(f); await assert.rejects(f.run, { code: 'ARGUS_SCA_RECEIPT_MISMATCH' }); }
});

test('multiple operations, trailing calldata and an unsupported wallet selector are not attributed to one action', async () => {
  for (const change of [
    f => { f.bundle.args[0].push(f.op); },
    f => { f.op.callData = '0x12345678'; },
  ]) {
    const f = setup(); change(f);
    f.state.transaction.input = encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: f.bundle.args });
    await assert.rejects(f.run, { code: 'ARGUS_SCA_RECEIPT_MISMATCH' });
  }
  const f = setup(); f.state.transaction.input += '00';
  await assert.rejects(f.run, /not canonical/);
});

test('a forged operation event hash, fee, duplicate or missing event rejects settlement', async () => {
  for (const change of [
    (f, event) => { event.topics[1] = `0x${'ab'.repeat(32)}`; },
    (f, event) => { event.data = `${event.data.slice(0, -64)}${'0'.repeat(63)}1`; },
    (f, event) => { f.state.receipt.logs.push(event); },
    (f, event) => { f.state.receipt.logs = f.state.receipt.logs.filter(log => log !== event); },
  ]) {
    const f = setup(); const event = f.state.receipt.logs.find(log => log.topics[0] === '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f');
    change(f, event); await assert.rejects(f.run, { code: 'ARGUS_SCA_RECEIPT_MISMATCH' });
  }
});

test('an exact failed wallet operation is settled as reverted while retaining its actual operation cost', async () => {
  const f = setup(); const event = f.state.receipt.logs.find(log => log.topics[0] === '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f');
  const parsed = decodeEventLog({ abi: entryPoint07Abi, eventName: 'UserOperationEvent', topics: event.topics, data: event.data }).args;
  event.data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [parsed.nonce, false, parsed.actualGasCost, parsed.actualGasUsed]);
  const result = await f.run(); assert.equal(result.state, 'reverted'); assert.equal(result.networkFeeWei, '10456685218968930');
});

test('packed hash binds init code, inner calldata, gas and paymaster fields', () => {
  const f = setup(); const expected = packedUserOperationHash(f.op);
  for (const field of ['initCode', 'callData', 'paymasterAndData']) assert.notEqual(packedUserOperationHash({ ...f.op, [field]: `${f.op[field]}00` }), expected);
  assert.notEqual(packedUserOperationHash({ ...f.op, nonce: 1n }), expected);
  assert.notEqual(packedUserOperationHash({ ...f.op, preVerificationGas: f.op.preVerificationGas + 1n }), expected);
  assert.notEqual(packedUserOperationHash(f.op, D.entryPoint, 1), expected);
});

function setOperationCall(f, data) {
  f.op.callData = data;
  f.state.transaction.input = encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: f.bundle.args });
  const event = f.state.receipt.logs.find(log => log.topics[0] === '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f');
  event.topics[1] = packedUserOperationHash(f.op);
}

function batchSetup(envelope = 'direct') {
  const f = setup();
  const batch = buildAtomicBatch({ account: f.step.from, steps: [
    { to: f.step.to, data: f.step.data, value: '0', label: 'Input approval' },
    { to: D.factory, data: '0x12345678', value: '0', label: 'Router approval' },
    { to: D.paymaster, data: '0x87654321', value: '0', label: 'Swap' },
  ] });
  Object.assign(f.step, JSON.parse(JSON.stringify(batch)));
  setOperationCall(f, envelope === 'direct' ? batch.data : encodeFunctionData({ abi: walletAbi, functionName: 'execute', args: [f.step.from, 0n, batch.data] }));
  return f;
}

for (const envelope of ['direct', 'self-target']) {
  test(`the ${envelope} atomic batch binds every call and counts one sponsored operation`, async () => {
    const f = batchSetup(envelope); const result = await f.run();
    assert.equal(result.verified, true); assert.equal(result.state, 'confirmed');
    assert.equal(result.exactAtomicBatch, true); assert.equal(result.exactSingleWalletCall, false);
    assert.equal(result.batchEnvelope, envelope); assert.equal(result.batchCallCount, 3);
    assert.equal(result.singleOperationBundle, true); assert.equal(result.networkFeeWei, '10456685218968930');
    assert.equal(result.target, f.step.from);
    assert.deepEqual(f.calls.filter(call => call.functionName === 'getExecutionHooks').map(call => call.args[0]),
      envelope === 'direct' ? [CIRCLE_BATCH_SELECTOR] : ['0xb61d27f6', CIRCLE_BATCH_SELECTOR]);
  });

  test(`the ${envelope} atomic batch rejects reordered, changed, added or removed actual subcalls`, async () => {
    for (const change of [
      calls => calls.reverse(), calls => { calls[0].target = D.factory; }, calls => { calls[1].data = '0x99999999'; },
      calls => { calls.push({ ...calls[0] }); }, calls => calls.pop(), calls => { calls[1].value = 1n; },
    ]) {
      const f = batchSetup(envelope);
      const decoded = decodeFunctionData({ abi: CIRCLE_BATCH_ABI, data: f.step.data });
      change(decoded.args[0]);
      const data = encodeFunctionData({ abi: CIRCLE_BATCH_ABI, functionName: 'executeBatch', args: decoded.args });
      setOperationCall(f, envelope === 'direct' ? data : encodeFunctionData({ abi: walletAbi, functionName: 'execute', args: [f.step.from, 0n, data] }));
      await assert.rejects(f.run, { code: 'ARGUS_SCA_RECEIPT_MISMATCH' });
    }
  });

  test(`the ${envelope} atomic batch rejects tampered saved calls and hidden hooks`, async () => {
    for (const change of [
      f => { f.step.batchCalls.reverse(); }, f => { f.step.batchCalls[0].data = '0x99999999'; },
      f => { f.step.batchCalls.push({ ...f.step.batchCalls[0] }); }, f => { f.step.batchCalls = []; },
      f => { f.step.batchCalls[0].value = '1'; }, f => { delete f.step.batchCalls; },
      f => { f.step.to = D.factory; }, f => { f.step.value = '1'; },
      f => { f.state.hooksBySelector = { [CIRCLE_BATCH_SELECTOR]: { getExecutionHooks: [{}] } }; },
      f => { f.state.hooksBySelector = { [CIRCLE_BATCH_SELECTOR]: { getPreValidationHooks: [[], [{}]] } }; },
    ]) {
      const f = batchSetup(envelope); change(f);
      await assert.rejects(f.run, { code: 'ARGUS_SCA_RECEIPT_MISMATCH' });
    }
  });

  test(`a reverted ${envelope} batch retains one fee and charges no principal`, async () => {
    const f = batchSetup(envelope); f.step.principalRaw = '4500000';
    const event = f.state.receipt.logs.find(log => log.topics[0] === '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f');
    const parsed = decodeEventLog({ abi: entryPoint07Abi, eventName: 'UserOperationEvent', topics: event.topics, data: event.data }).args;
    event.data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [parsed.nonce, false, parsed.actualGasCost, parsed.actualGasUsed]);
    const result = await f.run();
    assert.equal(result.state, 'reverted'); assert.equal(result.networkFeeWei, '10456685218968930');
    assert.equal(result.walletDebitLimitWei, result.networkFeeWei);
    addSystemTransfer(f, f.step.from, BigInt(result.networkFeeWei) + 1n);
    await assert.rejects(f.run, /Wallet USDC debit exceeds/);
  });
}

test('self-target batch rejects a changed outer target, nonzero value or an extra wrapper', async () => {
  for (const [target, value, wrap] of [[D.factory, 0n, false], [null, 1n, false], [null, 0n, true]]) {
    const f = batchSetup('self-target');
    const data = wrap ? f.op.callData : f.step.data;
    setOperationCall(f, encodeFunctionData({ abi: walletAbi, functionName: 'execute', args: [target ?? f.step.from, value, data] }));
    await assert.rejects(f.run, { code: 'ARGUS_SCA_RECEIPT_MISMATCH' });
  }
});

test('an existing account requalifies batch selectors on both sides of the receipt block', async () => {
  const f = batchSetup('self-target');
  f.state.priorCode = f.state.proxyCode;
  f.state.receipt.logs = f.state.receipt.logs.filter(log => !same(log.address, f.step.from));
  f.op.initCode = '0x'; setOperationCall(f, f.op.callData);
  assert.equal((await f.run()).verified, true);
  assert.deepEqual(f.calls.filter(call => call.functionName === 'getExecutionHooks').map(call => [call.blockNumber, call.args[0]]), [
    [f.state.receipt.blockNumber, '0xb61d27f6'], [f.state.receipt.blockNumber, CIRCLE_BATCH_SELECTOR],
    [f.state.receipt.blockNumber - 1n, '0xb61d27f6'], [f.state.receipt.blockNumber - 1n, CIRCLE_BATCH_SELECTOR],
  ]);
});
