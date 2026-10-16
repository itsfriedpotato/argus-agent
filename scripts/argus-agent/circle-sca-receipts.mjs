import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, zeroAddress } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { pacedReads } from './rpc-reads.mjs';
import { buildAtomicBatch, CIRCLE_BATCH_ABI, CIRCLE_BATCH_SELECTOR } from './batch.mjs';

// Observed Arc deployments qualified at block 24198894, not a compiler/source audit.
// Circle execute semantics: circlefin/buidl-wallet-contracts@f5e82e50f91b0128c11052bd398e55c9db84fae7,
// src/msca/6900/v0.7/account/BaseMSCA.sol:242 and managers/StandardExecutor.sol:36.
export const CIRCLE_SCA_DEPLOYMENT = Object.freeze({
  chainId: 5042,
  entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
  entryPointCodeHash: '0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58',
  proxyCodeHash: '0xd09e34b2e51f09092e73e3ba1d520a42972496bf2a3bfdb22bb50b9729a9fd66',
  implementation: '0x9c6e09bc32d1e012dcaa2623e66d2cc9860c1aed',
  implementationCodeHash: '0x60ecaaadc845f14626e77541b390bd36a7f5c35efdee5c30471f0eb08626019e',
  implementationSlot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  factory: '0x3fdcd9aa254aca13296219213df5e2ade36c85f9',
  factoryCodeHash: '0xf3d358d970936e606d7df401fa6f37cde68302264655be0d9e4faaf9a9311a94',
  paymaster: '0x03df76c8c30a88f424cf3cbbc36a1ca02763103b',
  paymasterCodeHash: '0x5595d653276b5124f9b24ef9fe3845faa9ed213bb0db5db9bfbea3683ce0ecda',
  paymasterImplementation: '0x36058cc257967db1912fc276f9cbec072cd572cb',
  paymasterImplementationCodeHash: '0x54ebbe581338d0a38164aec38dbf8e67dd6c4712ec17327b08bc896789ef41a8',
});
const D = CIRCLE_SCA_DEPLOYMENT;
const walletAbi = [...CIRCLE_BATCH_ABI, ...parseAbi([
  'function execute(address target,uint256 value,bytes data) returns(bytes)',
  'function getEntryPoint() view returns(address)',
  'function getNativeOwner() view returns(address)',
  'function getInstalledPlugins() view returns(address[])',
  'function getExecutionHooks(bytes4 selector) view returns(((address plugin,uint8 functionId) preExecHook,(address plugin,uint8 functionId) postExecHook)[])',
  'function getPreValidationHooks(bytes4 selector) view returns((address plugin,uint8 functionId)[],(address plugin,uint8 functionId)[])',
])];
const executeSelector = '0xb61d27f6';
const factoryAbi = parseAbi([
  'function createAccount(address sender,bytes32 salt,bytes initializingData) returns(address)',
  'function getAddress(address sender,bytes32 salt,bytes initializingData) view returns(address)',
]);
const opTopic = encodeEventTopics({ abi: entryPoint07Abi, eventName: 'UserOperationEvent' })[0];
const beforeExecutionTopic = encodeEventTopics({ abi: entryPoint07Abi, eventName: 'BeforeExecution' })[0];
const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const transferTopic = encodeEventTopics({ abi: transferAbi, eventName: 'Transfer' })[0];
const nativeUsdc = '0xfffffffffffffffffffffffffffffffffffffffe';
const initializationTopics = [
  '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b', // Upgraded
  '0xc8894f26f396ce8c004245c8b7cd1b92103a6e4302fcbab883987149ac01b7ec', // OwnershipTransferred
  '0xb9a2e77405e16894f62a69f7bd6a34b8ca7647b6f5d5408d7c577d275691fde3', // AccountInitialized
  '0x80bd505c666aa4feeb94643343d3e5acfd6d0b8c43c826331f5d543cbfa7e575', // Initialized
];
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const requireEvidence = (ok, message) => {
  if (!ok) throw Object.assign(new Error(message), { code: 'ARGUS_SCA_RECEIPT_MISMATCH', safe: true });
};
const uint = (value, label) => {
  requireEvidence(typeof value === 'bigint' && value >= 0n, `Missing or invalid ${label}.`);
  return value;
};
const recordedUint = (value, label) => {
  requireEvidence(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), `Missing or invalid saved ${label}.`);
  return BigInt(value);
};

/** Packed v0.7 hash, matching eth-infinitism/account-abstraction v0.7.0 UserOperationLib.hash. */
export function packedUserOperationHash(op, entryPoint = D.entryPoint, chainId = D.chainId) {
  const fields = ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'].map(type => ({ type }));
  const inner = keccak256(encodeAbiParameters(fields, [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData),
    op.accountGasLimits, op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData)]));
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [inner, entryPoint, BigInt(chainId)]));
}

async function qualifyWallet(client, address, blockNumber, selectors) {
  const [code, slot, plugins, entryPoint] = await Promise.all([
    client.getCode({ address, blockNumber }), client.getStorageAt({ address, slot: D.implementationSlot, blockNumber }),
    client.readContract({ address, abi: walletAbi, functionName: 'getInstalledPlugins', blockNumber }),
    client.readContract({ address, abi: walletAbi, functionName: 'getEntryPoint', blockNumber }),
  ]);
  requireEvidence(code && same(keccak256(code), D.proxyCodeHash), 'Circle proxy runtime differs from the qualified deployment.');
  requireEvidence(same(slot, `0x${'0'.repeat(24)}${D.implementation.slice(2)}`), 'Circle proxy implementation differs from the qualified deployment.');
  requireEvidence(Array.isArray(plugins) && plugins.length === 0, 'Installed Circle wallet plugins are outside this verifier.');
  // BaseMSCA.validateNativeFunction runs hooks for each selector; a self-target
  // executeBatch also runs its own runtime-validation hooks. Qualify both.
  for (const selector of selectors) {
    const [executionHooks, validationHooks] = await Promise.all([
      client.readContract({ address, abi: walletAbi, functionName: 'getExecutionHooks', args: [selector], blockNumber }),
      client.readContract({ address, abi: walletAbi, functionName: 'getPreValidationHooks', args: [selector], blockNumber }),
    ]);
    requireEvidence(Array.isArray(executionHooks) && executionHooks.length === 0 && Array.isArray(validationHooks)
      && validationHooks.length === 2 && validationHooks.every(hooks => Array.isArray(hooks) && hooks.length === 0),
    'Circle wallet execution or validation hooks are outside this verifier.');
  }
  requireEvidence(same(entryPoint, D.entryPoint), 'Circle wallet uses an unqualified EntryPoint.');
}

async function qualifySponsor(client, blockNumber) {
  const [code, slot, implementation] = await Promise.all([
    client.getCode({ address: D.paymaster, blockNumber }),
    client.getStorageAt({ address: D.paymaster, slot: D.implementationSlot, blockNumber }),
    client.getCode({ address: D.paymasterImplementation, blockNumber }),
  ]);
  requireEvidence(code && same(keccak256(code), D.paymasterCodeHash)
    && same(slot, `0x${'0'.repeat(24)}${D.paymasterImplementation.slice(2)}`)
    && implementation && same(keccak256(implementation), D.paymasterImplementationCodeHash),
  'The Circle sponsor runtime or implementation is outside the qualified deployment.');
}

/** Read-only envelope verification. This verifier accepts one UserOperation per bundle.
 * Semantic Argus events and token/allowance effects are verified separately by the SDK.
 * networkFeeWei counts UserOperationEvent cost even when sponsored; it is not wallet-debited gas.
 * Gross system-USDC debits are independently bounded by principal plus this cost.
 */
export async function verifyCircleSCAReceipt(client, { hash, step, action, readIntervalMs = 250 } = {}) {
  // Reuse the SDK queue when present; standalone verification gets the same pacing.
  // Tests may disable delays only for their injected in-memory client.
  client = pacedReads(client, readIntervalMs);
  requireEvidence(/^0x[0-9a-f]{64}$/i.test(hash ?? ''), 'A transaction hash is required.');
  requireEvidence(step && /^0x[0-9a-f]{40}$/i.test(step.from ?? '') && /^0x[0-9a-f]{40}$/i.test(step.to ?? '')
    && /^0x(?:[0-9a-f]{2})*$/i.test(step.data ?? '') && same(step.attempt?.from, step.from), 'A saved attempted Circle action is required.');
  requireEvidence(!step.hash || same(step.hash, hash), 'The saved step already names a different transaction.');
  const attemptBlock = recordedUint(step.attempt?.blockNumber, 'attempt block');
  const preparedBlock = action?.metadata?.preparedAtBlock === undefined ? attemptBlock : recordedUint(action.metadata.preparedAtBlock, 'preparation block');
  const startedMs = Date.parse(step.attempt?.startedAt);
  requireEvidence(Number.isFinite(startedMs) && startedMs >= 0, 'The saved attempt timestamp is required.');
  const approvedValue = recordedUint(step.value, 'native value');
  requireEvidence(await client.getChainId() === D.chainId, 'Circle receipt verification requires Arc mainnet.');
  const [transaction, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  requireEvidence(same(transaction.hash, hash) && same(receipt.transactionHash, hash) && transaction.chainId === D.chainId
    && same(transaction.to, D.entryPoint) && same(receipt.to, D.entryPoint) && same(receipt.from, transaction.from)
    && transaction.value === 0n, 'The outer transaction is not the qualified Arc EntryPoint call.');
  requireEvidence(transaction.type === 'eip1559' && !transaction.authorizationList?.length && !transaction.blobVersionedHashes?.length,
    'Unsupported outer transaction envelope.');
  requireEvidence(receipt.status === 'success', 'The outer EntryPoint call did not complete; no UserOperation settlement is established.');
  const number = uint(receipt.blockNumber, 'receipt block');
  requireEvidence(number > 0n && number >= attemptBlock && number >= preparedBlock && transaction.blockNumber === number
    && same(transaction.blockHash, receipt.blockHash) && transaction.transactionIndex === receipt.transactionIndex
    && Number.isSafeInteger(receipt.transactionIndex) && receipt.transactionIndex >= 0, 'Receipt inclusion predates or differs from the saved attempt.');
  const block = await client.getBlock({ blockNumber: number });
  requireEvidence(block.number === number && same(block.hash, receipt.blockHash) && Array.isArray(block.transactions)
    && same(typeof block.transactions[receipt.transactionIndex] === 'string' ? block.transactions[receipt.transactionIndex] : block.transactions[receipt.transactionIndex]?.hash, hash),
  'The transaction is not at its claimed index in the canonical block.');
  // Two seconds accommodate block timestamps rounded to seconds; the saved block bound is independent.
  requireEvidence(uint(block.timestamp, 'block timestamp') + 2n >= BigInt(Math.floor(startedMs / 1000)), 'The transaction predates the saved attempt timestamp.');
  const [entryCode, implementationCode, priorCode] = await Promise.all([
    client.getCode({ address: D.entryPoint, blockNumber: number }), client.getCode({ address: D.implementation, blockNumber: number }),
    client.getCode({ address: step.from, blockNumber: number - 1n }),
  ]);
  requireEvidence(entryCode && same(keccak256(entryCode), D.entryPointCodeHash), 'EntryPoint runtime differs from the qualified deployment.');
  requireEvidence(implementationCode && same(keccak256(implementationCode), D.implementationCodeHash), 'Circle implementation runtime differs from the qualified deployment.');
  let bundle;
  try { bundle = decodeFunctionData({ abi: entryPoint07Abi, data: transaction.input }); }
  catch { requireEvidence(false, 'The EntryPoint calldata cannot be decoded.'); }
  requireEvidence(bundle.functionName === 'handleOps' && bundle.args[0].length === 1, 'This verifier requires exactly one UserOperation per EntryPoint bundle.');
  requireEvidence(same(encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: bundle.args }), transaction.input), 'The EntryPoint calldata is not canonical.');
  const op = bundle.args[0][0];
  requireEvidence(same(op.sender, step.from), 'The UserOperation sender differs from the approved Circle wallet.');
  const paymaster = op.paymasterAndData.slice(0, 42);
  requireEvidence(op.paymasterAndData.length >= 106 && same(paymaster, D.paymaster), 'Only the qualified Circle sponsor is supported by this verifier.');
  let inner;
  try { inner = decodeFunctionData({ abi: walletAbi, data: op.callData }); }
  catch { requireEvidence(false, 'The wallet call is not a supported execution.'); }
  let batchEnvelope;
  let selectors = [executeSelector];
  if (step.batchCalls !== undefined) {
    let batch;
    try { batch = buildAtomicBatch({ account: step.from, steps: step.batchCalls }); }
    catch { requireEvidence(false, 'The saved atomic batch is invalid.'); }
    requireEvidence(same(step.to, batch.to) && approvedValue === 0n && same(step.data, batch.data),
      'The saved batch calldata differs from its exact ordered calls.');
    if (inner.functionName === 'executeBatch') {
      requireEvidence(same(op.callData, batch.data), 'The direct wallet batch differs from the exact saved calls.');
      batchEnvelope = 'direct'; selectors = [CIRCLE_BATCH_SELECTOR];
    } else {
      requireEvidence(inner.functionName === 'execute'
        && same(encodeFunctionData({ abi: walletAbi, functionName: 'execute', args: inner.args }), op.callData)
        && same(inner.args[0], step.from) && inner.args[1] === 0n && same(inner.args[2], batch.data),
      'The self-target wallet batch differs from the exact saved calls.');
      batchEnvelope = 'self-target'; selectors = [executeSelector, CIRCLE_BATCH_SELECTOR];
    }
  } else {
    requireEvidence(!(same(step.to, step.from) && same(step.data.slice(0, 10), CIRCLE_BATCH_SELECTOR)),
      'An atomic wallet batch requires its saved ordered calls.');
    requireEvidence(inner.functionName === 'execute' && same(encodeFunctionData({ abi: walletAbi, functionName: 'execute', args: inner.args }), op.callData)
      && same(inner.args[0], step.to) && inner.args[1] === approvedValue && same(inner.args[2], step.data),
    'The Circle wallet target, value or calldata differs from the saved action.');
  }
  await qualifyWallet(client, step.from, number, selectors);
  const deployedNow = !priorCode || priorCode === '0x';
  if (!deployedNow) {
    requireEvidence(op.initCode === '0x', 'An existing Circle account unexpectedly includes factory initialization.');
    await qualifyWallet(client, step.from, number - 1n, selectors);
  } else {
    requireEvidence(same(op.initCode.slice(0, 42), D.factory), 'Circle account initialization uses an unqualified factory.');
    const factoryCode = await client.getCode({ address: D.factory, blockNumber: number });
    requireEvidence(factoryCode && same(keccak256(factoryCode), D.factoryCodeHash), 'Circle factory runtime differs from the qualified deployment.');
    let init;
    try { init = decodeFunctionData({ abi: factoryAbi, data: `0x${op.initCode.slice(42)}` }); }
    catch { requireEvidence(false, 'Circle factory initialization cannot be decoded.'); }
    requireEvidence(init.functionName === 'createAccount' && same(encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: init.args }), `0x${op.initCode.slice(42)}`)
      && same(init.args[2], encodeAbiParameters([{ type: 'address' }], [init.args[0]])), 'Circle factory initialization is not the qualified single-owner form.');
    const [predicted, owner] = await Promise.all([
      client.readContract({ address: D.factory, abi: factoryAbi, functionName: 'getAddress', args: init.args, blockNumber: number }),
      client.readContract({ address: step.from, abi: walletAbi, functionName: 'getNativeOwner', blockNumber: number }),
    ]);
    requireEvidence(same(predicted, step.from) && same(owner, init.args[0]), 'Circle factory address or native owner does not match its initialization.');
  }
  requireEvidence(Array.isArray(receipt.logs), 'Receipt logs are missing.');
  for (const log of receipt.logs) requireEvidence(log.removed !== true && same(log.transactionHash, hash) && same(log.blockHash, receipt.blockHash)
    && log.blockNumber === number && log.transactionIndex === receipt.transactionIndex, 'A log is not bound to this canonical transaction.');
  const [walletBlockLogs, sponsorBlockLogs, balanceBefore, balanceAfter] = await Promise.all([
    client.getLogs({ address: step.from, fromBlock: number, toBlock: number }),
    client.getLogs({ address: D.paymaster, fromBlock: number, toBlock: number }),
    client.getBalance({ address: step.from, blockNumber: number - 1n }),
    client.getBalance({ address: step.from, blockNumber: number }),
  ]);
  // Keep public RPC bursts bounded; a ten-read fan-out triggers its rate limit.
  await qualifySponsor(client, number - 1n);
  await qualifySponsor(client, number);
  // These account calls emit no wallet events. Reject every other wallet/sponsor event in
  // the whole block so an upgrade/hook installation followed by removal cannot hide at block ends.
  requireEvidence(Array.isArray(sponsorBlockLogs) && sponsorBlockLogs.length === 0, 'Sponsor changes or events in the execution block require separate qualification.');
  requireEvidence(Array.isArray(walletBlockLogs), 'Wallet block logs are missing.');
  if (deployedNow) {
    const before = receipt.logs.filter(log => same(log.address, D.entryPoint) && same(log.topics?.[0], beforeExecutionTopic));
    const initial = receipt.logs.filter(log => same(log.address, step.from));
    requireEvidence(before.length === 1 && initial.length === initializationTopics.length && walletBlockLogs.length === initial.length
      && initial.every((log, index) => same(log.topics[0], initializationTopics[index]) && log.logIndex < before[0].logIndex)
      && same(initial[0].topics[1], `0x${'0'.repeat(24)}${D.implementation.slice(2)}`)
      && walletBlockLogs.every(log => log.removed !== true && log.blockNumber === number && same(log.blockHash, receipt.blockHash)
        && same(log.transactionHash, hash) && log.transactionIndex === receipt.transactionIndex
        && initial.some(item => item.logIndex === log.logIndex && same(item.data, log.data)
          && item.topics.length === log.topics.length && item.topics.every((topic, index) => same(topic, log.topics[index])))),
    'Wallet events in the execution block differ from the qualified factory initialization.');
  } else requireEvidence(walletBlockLogs.length === 0, 'Wallet changes or events in the execution block require separate qualification.');
  const logs = receipt.logs.filter(log => same(log.address, D.entryPoint) && same(log.topics?.[0], opTopic));
  requireEvidence(logs.length === 1, 'Expected exactly one canonical UserOperationEvent.');
  let event;
  try { event = decodeEventLog({ abi: entryPoint07Abi, eventName: 'UserOperationEvent', topics: logs[0].topics, data: logs[0].data, strict: true }).args; }
  catch { requireEvidence(false, 'The UserOperationEvent cannot be decoded.'); }
  const userOperationHash = packedUserOperationHash(op);
  requireEvidence(same(event.userOpHash, userOperationHash) && same(event.sender, op.sender) && event.nonce === op.nonce
    && same(event.paymaster, paymaster), 'The UserOperationEvent does not bind to the exact decoded operation.');
  const maxFee = BigInt(`0x${op.gasFees.slice(34)}`);
  const priorityFee = BigInt(op.gasFees.slice(0, 34));
  const baseFee = uint(block.baseFeePerGas, 'block base fee');
  const gasPrice = baseFee + priorityFee < maxFee ? baseFee + priorityFee : maxFee;
  const cost = uint(event.actualGasCost, 'UserOperation cost');
  const gasUsed = uint(event.actualGasUsed, 'UserOperation gas');
  requireEvidence(maxFee >= baseFee && priorityFee <= maxFee && gasUsed > 0n && cost === gasUsed * gasPrice,
    'The UserOperation fee does not match its packed gas prices and canonical block.');
  const debitLimit = (event.success ? recordedUint(step.principalRaw, 'principal') * 10n ** 12n : 0n) + cost;
  let grossDebit = 0n;
  for (const log of receipt.logs.filter(log => same(log.address, nativeUsdc) && same(log.topics?.[0], transferTopic))) {
    let transfer;
    try { transfer = decodeEventLog({ abi: transferAbi, topics: log.topics, data: log.data, strict: true }).args; }
    catch { requireEvidence(false, 'A system USDC transfer cannot be decoded.'); }
    if (same(transfer.from, step.from)) grossDebit += transfer.value;
  }
  const blockDebit = uint(balanceBefore, 'wallet balance before') > uint(balanceAfter, 'wallet balance after') ? balanceBefore - balanceAfter : 0n;
  requireEvidence(grossDebit <= debitLimit && blockDebit <= debitLimit, 'Wallet USDC debit exceeds the saved principal plus operation cost.');
  return { verified: true, state: event.success ? 'confirmed' : 'reverted', hash: hash.toLowerCase(),
    networkFeeWei: cost.toString(), feeAccounting: 'conservative-user-operation-cost', paymasterUsed: !same(paymaster, zeroAddress), paymaster,
    walletGrossDebitWei: grossDebit.toString(), walletBlockDebitWei: blockDebit.toString(), walletDebitLimitWei: debitLimit.toString(),
    userOperationHash, userOperationNonce: op.nonce.toString(), userOperationGasUsed: gasUsed.toString(),
    blockNumber: number.toString(), blockHash: receipt.blockHash, sender: op.sender, target: step.to,
    singleOperationBundle: true, exactSingleWalletCall: !batchEnvelope,
    ...(batchEnvelope ? { exactAtomicBatch: true, batchEnvelope, batchCallCount: step.batchCalls.length } : {}),
    deploymentQualificationBlock: '24198894', receipt, transaction };
}
