import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createPublicClient, createWalletClient, decodeEventLog, getAddress, http, keccak256, parseAbi, parseUnits, recoverTransactionAddress, serializeTransaction } from 'viem';
import { catalog, validateOperation } from './catalog.mjs';
import { createContractAdapter } from './contracts.mjs';
import { buildAtomicBatch } from './batch.mjs';
import { createReadOperations } from './reads.mjs';
import { pacedReads } from './rpc-reads.mjs';
import { createLockAdapter, CURRENT_TIME_LOCK, MIN_LOCK_LEAD_SECONDS } from './locks.mjs';
import { createStore, AgentStoreError, MAINNET_BUDGET_CAP_USDC_RAW } from './store.mjs';
import { exportProjectManifest, projectManagementLink, verifyProjectImport, verifyPositionRecovery } from './project-import.mjs';
import { assertLocalRpc } from './vendor/intent.mjs';
import { assertPrivateConfigFile } from './private-files.mjs';

const bundle = JSON.parse(readFileSync(new URL('./vendor/argus-v4.json', import.meta.url), 'utf8'));
const addresses = bundle.portal8.addresses;
const portalAbi = bundle.portal8.contracts.ArgusV5Portal.abi;
const registryAbi = bundle.portal8.contracts.ArgusV5CreatorRegistry.abi;
const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const timeLockAbi = parseAbi([
  'struct Lock { address token; uint64 unlockAt; bool withdrawn; address owner; uint64 lockedAt; uint256 amount; }',
  'function getLock(uint256 id) view returns (Lock)',
  'event Locked(uint256 indexed id,address indexed token,address indexed owner,address depositor,uint256 amount,uint64 unlockAt)',
  'event Withdrawn(uint256 indexed id,address indexed token,address indexed owner,uint256 amount)',
]);
const lockVaultAbi = parseAbi(['function locked(address token) view returns (uint256)', 'event Locked(address indexed token,address indexed from,uint256 delta,uint256 totalLocked)']);
const plain = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const planDigest = action => digest({ expected: action.expected, summary: action.summary,
  steps: action.steps.map(({ to, data, value, from, gas, maxFeePerGas, abi, gasReserveWei, batchCalls }) => ({ to, data, value, from, gas, maxFeePerGas, abi, ...(gas === undefined ? { gasReserveWei } : {}), ...(batchCalls === undefined ? {} : { batchCalls }) })) });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = (code, message) => { throw Object.assign(new Error(message), { code, safe: true }); };
const pending = new Set(['submitting', 'submitted', 'unknown']);
const events = (receipt, target, abi, name) => receipt.logs.filter(log => same(log.address, target)).flatMap(log => {
  try { const event = decodeEventLog({ abi, data: log.data, topics: log.topics }); return event.eventName === name ? [event.args] : []; } catch { return []; }
});
function publicAction(action) {
  if (!action) return action;
  const result = { ...action };
  delete result.leaseId;
  result.steps = action.steps.map(item => { const step = { ...item }; delete step.abi; return step; });
  return result;
}

/** Prove a Circle-local receipt carries a real signature, independently of Anvil impersonation. */
export async function verifyCircleTransactionSignature(tx, expectedHash, expectedSender) {
  try {
    if (tx.type !== 'eip1559' || ![tx.r, tx.s].every(value => typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) !== 0n)) throw new Error('Missing signature');
    // JSON-RPC quantities may omit leading zero nibbles; normalize numeric signature values.
    const [r, s] = [tx.r, tx.s].map(value => `0x${BigInt(value).toString(16).padStart(64, '0')}`);
    const yParity = tx.yParity ?? ([0n, 1n, 27n, 28n].includes(tx.v) ? Number(tx.v >= 27n ? tx.v - 27n : tx.v) : undefined);
    if (yParity !== 0 && yParity !== 1) throw new Error('Invalid signature parity');
    const serializedTransaction = serializeTransaction({ type: 'eip1559', chainId: tx.chainId, nonce: tx.nonce, to: tx.to, data: tx.input,
      value: tx.value, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: tx.accessList ?? [] },
    { r, s, yParity });
    const transactionHash = keccak256(serializedTransaction);
    if (!same(transactionHash, expectedHash) || !same(transactionHash, tx.hash)) throw new Error('Signed transaction hash mismatch');
    const recoveredAddress = await recoverTransactionAddress({ serializedTransaction });
    if (!same(recoveredAddress, expectedSender) || !same(recoveredAddress, tx.from)) throw new Error('Signed transaction sender mismatch');
    return { verified: true, type: 'eip1559', recoveredAddress, transactionHash };
  } catch { fail('ARGUS_SIGNATURE_MISMATCH', 'Circle transaction signature does not match the saved sender and canonical transaction hash.'); }
}

export async function createArgusAgentFromConfig(configPath) {
  if (!isAbsolute(configPath ?? '')) fail('ARGUS_CONFIG_REQUIRED', 'Provide an absolute ARGUS_AGENT_CONFIG path.');
  try { assertPrivateConfigFile(configPath, { maxBytes: 64 * 1024 }); }
  catch (error) { if (error.code === 'ARGUS_PRIVATE_FILE') fail('ARGUS_CONFIG_UNSAFE', error.message); throw error; }
  return createArgusAgent(JSON.parse(readFileSync(configPath, 'utf8')));
}

/** One journal and operation engine shared by CLI/skill and MCP. */
export async function createArgusAgent(config, dependencies = {}) {
  // Keep the chosen chain, wallet identity and execution policy immutable in this engine.
  config = plain(config);
  const mvp = config.mode === 'mainnet-mvp';
  const mainnet = config.mode === 'mainnet' || mvp;
  if (mvp) config.budgetUsdcRaw ??= '10000000';
  if (!mainnet && config.mode !== 'local-fork') fail('ARGUS_MODE_UNSUPPORTED', 'Choose the isolated local fork or an explicitly enabled mainnet workspace.');
  if (mainnet) {
    if (!mvp && config.executionEnabled !== true) fail('ARGUS_EXECUTION_DISABLED', 'Mainnet execution must be explicitly enabled in the private workspace configuration.');
    let rpc;
    try { rpc = new URL(config.rpcUrl); } catch { fail('ARGUS_RPC_UNSAFE', 'Use the official HTTPS Arc mainnet RPC.'); }
    if (!['https://rpc.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io'].includes(rpc.origin) || !['', '/'].includes(rpc.pathname) || rpc.search || rpc.hash || rpc.username || rpc.password)
      fail('ARGUS_RPC_UNSAFE', 'Use the allowlisted official HTTPS Arc mainnet RPC without credentials, query parameters or redirects.');
    // MVP workspaces take a budget up to the cap; the closed historical pilot keeps its one 10 USDC journal.
    if (config.chainId !== 5042 || config.identity?.chainId !== 5042 || (mvp ? !/^[1-9][0-9]{0,8}$/.test(config.budgetUsdcRaw) || BigInt(config.budgetUsdcRaw) > MAINNET_BUDGET_CAP_USDC_RAW : config.budgetUsdcRaw !== '10000000')
      || ((config.executionEnabled === true || !mvp) && config.executor?.kind !== 'circle-hosted') || config.faults)
      fail('ARGUS_CONFIG_UNSAFE', 'Mainnet requires Arc 5042, a budget of at most 100 USDC (the historical pilot keeps its one 10 USDC journal), hosted Circle execution and no injected faults.');
  } else assertLocalRpc(config.rpcUrl);
  if (!isAbsolute(config.stateDir ?? '')) fail('ARGUS_CONFIG_UNSAFE', 'Use an absolute retained state directory.');
  if (mvp && config.actors) config.actors.treasury ??= config.actors.controller;
  const roles = Object.fromEntries(Object.entries(config.actors ?? {}).map(([key, value]) => [key, getAddress(value)]));
  if ((mainnet && Object.keys(roles).sort().join(',') !== 'controller,operator,treasury') || !roles.operator || !roles.controller || !roles.treasury || Object.values(roles).some(value => /^0x0{40}$/i.test(value)))
    fail('ARGUS_ROLES_INVALID', 'Configure exactly the operator, controller and treasury addresses.');
  if (mainnet ? !same(roles.operator, config.identity.circleWallet) || !(same(roles.treasury, config.identity.circleWallet) || (mvp && same(roles.treasury, roles.controller)))
    || !same(roles.controller, config.identity.fundingWallet) || same(roles.controller, roles.operator)
    : new Set([roles.operator, roles.controller, roles.treasury]).size !== 3)
    fail('ARGUS_ROLES_INVALID', mainnet ? 'The bound Circle wallet is operator, the human wallet is payout controller, and treasury must be an explicitly supported role.' : 'Configure distinct operator, controller and treasury addresses.');
  if (mainnet && config.contracts && (!same(config.contracts.portal, addresses.portal) || !same(config.contracts.usdc, addresses.defaultQuoteAsset)
    || !same(config.contracts.timeLock, CURRENT_TIME_LOCK) || !same(config.contracts.lockVault, addresses.lockVault)))
    fail('ARGUS_CONFIG_UNSAFE', 'Configured mainnet contracts differ from the qualified deployments.');
  const chain = { id: 5042, name: mainnet ? 'arc-mainnet-pilot' : 'argus-local-comparison', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } };
  const transport = http(config.rpcUrl, { batch: false, retryCount: 0, timeout: 30_000, fetchOptions: { redirect: 'error' } });
  const rawClient = dependencies.client ?? createPublicClient({ chain, transport });
  // Only an explicitly injected test client can change pacing; user configuration cannot.
  const client = mainnet ? pacedReads(rawClient, dependencies.client ? dependencies.readIntervalMs ?? 250 : 250) : rawClient;
  async function checkRuntime() {
    if (await client.getChainId() !== chain.id) fail('ARGUS_RPC_UNSAFE', 'The configured RPC must report Arc chain 5042.');
    if (mainnet) return;
    if (!/anvil/i.test(await client.request({ method: 'web3_clientVersion' }))) fail('ARGUS_RPC_UNSAFE', 'Execution requires the isolated Anvil fork.');
    const metadata = await client.request({ method: 'anvil_metadata' });
    if (Number(metadata.forkedNetwork?.forkBlockNumber) !== 24109098) fail('ARGUS_RPC_UNSAFE', 'The configured fork block is not the qualified ownership-test block.');
    const block = await client.getBlock({ blockNumber: 24109098n });
    if (block.hash !== '0xedec9ae822db30bd63100fdd62cbe7691a25a834569321b1b7b6d09b52937292') fail('ARGUS_RPC_UNSAFE', 'Fork block identity mismatch.');
  }
  async function currentFeeFloor() {
    const [gasPrice, block] = await Promise.all([client.getGasPrice(), client.getBlock({ blockTag: 'latest' })]);
    const baseFee = block.baseFeePerGas;
    if (typeof gasPrice !== 'bigint' || gasPrice < 0n || typeof baseFee !== 'bigint' || baseFee < 0n)
      fail('ARGUS_FEE_UNAVAILABLE', 'Current gas price and block base fee are required to bound execution costs.');
    // Anvil's gas-price oracle can lag the block base fee after snapshot restoration.
    return gasPrice > baseFee ? gasPrice : baseFee;
  }
  if (!mvp) await checkRuntime();
  const store = mainnet ? createStore(config.stateDir, { mode: config.mode, initialization: 'open', identity: config.identity, budgetUsdcRaw: config.budgetUsdcRaw })
    : dependencies.store ?? createStore(config.stateDir, { budgetUsdcRaw: config.budgetUsdcRaw ?? '10000000' });
  const contracts = dependencies.contracts ?? createContractAdapter(client);
  const reads = createReadOperations({ client, store, roles });
  const locks = dependencies.locks ?? createLockAdapter(client, { timeLock: CURRENT_TIME_LOCK, lockVault: addresses.lockVault });
  let verifyHostedReceipt = dependencies.verifyCircleSCAReceipt;
  if (mainnet && !verifyHostedReceipt) {
    try { ({ verifyCircleSCAReceipt: verifyHostedReceipt } = await import('./circle-sca-receipts.mjs')); }
    catch { store.close(); fail('ARGUS_SCA_VERIFIER_UNAVAILABLE', 'The qualified Circle smart-account receipt verifier is required before mainnet execution.'); }
  }
  if (mainnet && typeof verifyHostedReceipt !== 'function') { store.close(); fail('ARGUS_SCA_VERIFIER_UNAVAILABLE', 'The qualified Circle smart-account receipt verifier is unavailable.'); }
  let executor = dependencies.executor;
  if (!executor && mainnet && config.executionEnabled === true) {
    const { createCircleHostedExecutor } = await import('./circle-hosted-executor.mjs');
    try {
      executor = createCircleHostedExecutor({ ...config.executor, accounts: [roles.operator], authorize: async tx => store.listActions().some(action => action.steps.some(step =>
        step.status === 'submitting' && step.attempt?.id === tx.operationId && same(step.from, tx.account) && same(step.to, tx.to)
        && step.data === tx.data && BigInt(step.value) === BigInt(tx.value))) });
    } catch { store.close(); fail('ARGUS_EXECUTOR_UNAVAILABLE', 'Configure the qualified patched hosted Circle runtime and its private session directory.'); }
  }
  if (!mainnet && !executor && config.executor?.kind === 'circle-local') {
    const { createCircleExecutor } = await import('./circle-executor.mjs');
    executor = createCircleExecutor({ ...config.executor, rpcUrl: config.rpcUrl, chainId: chain.id, accounts: Object.values(roles), authorize: async () => true });
  } else if (!mainnet && !executor && config.executor?.kind === 'anvil') {
    executor = { async execute(tx) {
      const wallet = createWalletClient({ account: tx.account, chain, transport });
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value), gas: BigInt(tx.gas),
        maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: 0n, nonce: Number(tx.nonce) });
      return { status: 'submitted', hash };
    } };
  }
  if (!executor && !(mvp && config.executionEnabled !== true)) { store.close(); fail('ARGUS_EXECUTOR_UNAVAILABLE', 'Choose an explicitly configured executor.'); }
  const coverage = { execution: config.executor?.kind ?? (mvp ? 'disabled' : 'injected-test-executor'), localFork: !mainnet,
    get authenticatedCircleAgentWallet() { return this.verifiedMainnetTransactionCount > 0; },
    get mainnetTransactions() { return this.verifiedMainnetTransactionCount > 0; },
    get verifiedMainnetTransactionCount() { return mainnet ? store.listActions().reduce((count, action) => count + action.steps.filter(step => ['confirmed', 'reverted'].includes(step.status) && step.receipt?.verified === true).length, 0) : 0; },
    mainnetExecutionMode: mainnet, executionEnabled: mainnet ? config.executionEnabled === true : true, nativeUsdcPrecompile: false, indexedDiscovery: false, productionDelegationEnforcement: false,
    ...(mainnet ? { budgetEnforcement: 'application-accounting-only', exactFeeCeiling: false, feeReservation: 'estimate-with-headroom', experimentId: config.identity.experimentId } : {}) };
  const knownProject = token => {
    const project = store.listProjects().find(item => same(item.token, token));
    if (!project) fail('ARGUS_PROJECT_NOT_TRACKED', 'This workspace has no verified reference for the token. Import its launch receipt; no historical scan was started.');
    return project;
  };
  function onceFault(name) {
    if (!config.faults?.[name]) return false;
    const path = join(config.stateDir, `fault-${name}.used`);
    if (existsSync(path)) return false;
    try { writeFileSync(path, 'used\n', { flag: 'wx', mode: 0o600 }); return true; } catch { return false; }
  }
  async function prepare(name, args) {
    await checkRuntime();
    if (mvp && name !== 'argus_prepare_project') {
      knownProject(args.token);
      if (name === 'argus_prepare_management' && args.operation !== 'claim_fees') {
        const current = await contracts.readProject(args.token);
        const requiredSigner = args.operation === 'accept_owner' ? current.proposed : current.controller;
        return { status: 'needs_human_signature', management: projectManagementLink(args.token, requiredSigner, args.operation), coverage: { ...coverage } };
      }
      if (['argus_prepare_trade', 'argus_prepare_lock'].includes(name) && args.operation !== 'withdraw' && !same(roles.treasury, roles.operator)) {
        return { status: 'needs_human_signature', management: projectManagementLink(args.token, roles.treasury, args.operation ?? args.side), coverage: { ...coverage } };
      }
      if (name === 'argus_prepare_lock' && args.operation === 'withdraw') {
        const record = await client.readContract({ address: CURRENT_TIME_LOCK, abi: timeLockAbi, functionName: 'getLock', args: [BigInt(args.lockId)] });
        if (!same(record.token, args.token)) fail('ARGUS_LOCK_MISMATCH', 'The lock belongs to a different token.');
        if (!same(record.owner, roles.operator)) return { status: 'needs_human_signature', management: projectManagementLink(args.token, record.owner, args.operation, { lockId: args.lockId }), coverage: { ...coverage } };
      }
    }
    if (mvp && config.executionEnabled !== true) fail('ARGUS_EXECUTION_DISABLED', 'This workspace is read-only. Import and inspect projects without connecting a Circle executor.');
    const terms = { operation: name, args, roles, chainId: chain.id, ...(mainnet ? { mode: config.mode, identity: config.identity } : {}) };
    const termsHash = digest(terms);
    const existing = store.getByIdempotencyKey(args.idempotencyKey);
    if (existing) {
      if (existing.termsHash !== termsHash) fail('IDEMPOTENCY_CONFLICT', 'Keep the original key and identical terms. This key already names another request.');
      return { action: publicAction(await reconcile(existing.id)), budget: store.budget(), coverage: { ...coverage } };
    }
    let plan;
    let actor;
    let kind;
    if (name === 'argus_prepare_project') {
      actor = roles.operator; kind = 'launch';
      plan = await contracts.prepareProject({ ...args, ...roles });
    } else {
      knownProject(args.token);
      if (name === 'argus_prepare_trade') { actor = roles.treasury; kind = 'trade'; plan = await contracts.prepareTrade({ ...args, actor }); }
      else if (name === 'argus_prepare_lock') {
        if (!mainnet) fail('ARGUS_MODE_UNSUPPORTED', 'Journal-backed lock actions require an explicitly enabled mainnet workspace.');
        actor = mvp && args.operation === 'withdraw' ? roles.operator : roles.treasury; kind = 'lock';
        const input = { ...args, actor, inventoryRaw: store.getInventory(args.token, actor).availableRaw };
        if (args.operation === 'timed') plan = await locks.prepareTimeLock({ ...input, beneficiary: mvp ? roles.controller : actor });
        else if (args.operation === 'permanent') plan = await locks.preparePermanentLock(input);
        else plan = await locks.prepareWithdraw(input);
        plan = { ...plan, expected: { ...plan.expected, operation: args.operation } };
      } else {
        kind = 'management';
        const current = await contracts.readProject(args.token);
        actor = args.operation === 'claim_fees' ? roles.operator : args.operation === 'accept_owner' ? current.proposed : current.controller;
        if (mainnet && !same(actor, roles.operator)) fail('ARGUS_MANUAL_SIGNER_UNAVAILABLE', 'This action requires the human payout controller. Its manual signing route is not available through hosted Circle execution.');
        if (!Object.values(roles).some(address => same(actor, address))) fail('ARGUS_SIGNER_UNAVAILABLE', 'The current required controller is not a configured local signer.');
        plan = await contracts.prepareManagement({ ...args, actor });
      }
    }
    const maxFeePerGas = mainnet ? null : (await currentFeeFloor()) * 2n + 1n;
    let steps = plan.steps.map((step, index) => {
      if (mainnet) {
        const feeReserve = index < plan.steps.length - 1 ? '0.05' : kind === 'launch' ? '0.70' : kind === 'trade' ? '0.08' : '0.05';
        return { ...step, from: actor, gasReserveWei: parseUnits(feeReserve, 18).toString(), exactFeeCeiling: false };
      }
      const gas = index === plan.steps.length - 1 ? kind === 'launch' ? 15_000_000n : kind === 'trade' ? 2_000_000n : 500_000n : 150_000n;
      return { ...step, from: actor, gas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), gasReserveWei: (gas * maxFeePerGas).toString() };
    });
    // Only newly prepared hosted trades are batched. Existing journals retain
    // their exact submitted or prepared steps and the same idempotency identity.
    if (mainnet && kind === 'trade' && steps.length > 1) {
      const gasReserveWei = steps.reduce((sum, step) => sum + BigInt(step.gasReserveWei), 0n).toString();
      steps = [{ ...buildAtomicBatch({ account: actor, steps: plan.steps }), from: actor, gasReserveWei, exactFeeCeiling: false }];
      plan = { ...plan, summary: { ...plan.summary, execution: 'atomic-batch', contractCalls: plan.steps.length, submissions: 1 } };
    }
    const preparedAtBlock = await client.getBlockNumber({ cacheTime: 0 });
    const action = store.prepare({ idempotencyKey: args.idempotencyKey, kind, terms, termsHash, steps, expected: plan.expected,
      summary: plan.summary, principalRaw: plan.summary.spendUsdcRaw ?? '0', metadata: { planDigest: planDigest({ ...plan, steps }), preparedAtBlock: preparedAtBlock.toString(), expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), executionMode: config.executor.kind } });
    return { action: publicAction(action), budget: store.budget(), coverage: { ...coverage } };
  }
  async function verifyReceipt(action, step, hash) {
    let receipt;
    let evidence;
    if (mainnet) {
      const result = await verifyHostedReceipt(client, { hash, step, action });
      if (result?.verified !== true || !['confirmed', 'reverted'].includes(result.state) || !same(result.hash, hash)
        || !/^\d+$/.test(result.networkFeeWei ?? '') || !result.receipt || !result.transaction)
        fail('ARGUS_RECEIPT_MISMATCH', 'The hosted smart-account execution and its actual network cost could not be verified.');
      ({ receipt } = result);
      evidence = plain(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'receipt' && key !== 'transaction')));
    } else {
      receipt = await client.getTransactionReceipt({ hash });
      const tx = await client.getTransaction({ hash });
      const canonicalBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (receipt.blockHash !== canonicalBlock.hash || !same(tx.from, step.from) || !same(tx.to, step.to) || tx.input !== step.data ||
          tx.value !== BigInt(step.value) || tx.chainId !== chain.id || tx.nonce !== Number(step.attempt.nonce))
        fail('ARGUS_RECEIPT_MISMATCH', 'Transaction evidence does not match the saved action. No replacement was submitted.');
      evidence = { verified: true, state: receipt.status === 'success' ? 'confirmed' : 'reverted', hash,
        networkFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), gasLimit: tx.gas.toString(),
        maxFeePerGas: (tx.maxFeePerGas ?? tx.gasPrice).toString(), blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
      if (config.executor?.kind === 'circle-local') {
        if (tx.gas !== BigInt(step.gas) || tx.maxFeePerGas !== BigInt(step.maxFeePerGas) || tx.maxPriorityFeePerGas !== 0n)
          fail('ARGUS_RECEIPT_MISMATCH', 'Circle transaction gas and fee fields differ from the exact approved envelope.');
        evidence.signature = await verifyCircleTransactionSignature(tx, hash, step.from);
      }
    }
    if (evidence.state !== 'confirmed' || step.index !== action.steps.length - 1) return evidence;
    const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: receipt.blockNumber });
    const expected = action.expected;
    if (action.kind === 'launch') {
      const launches = events(receipt, addresses.portal, portalAbi, 'Launched');
      assert.equal(launches.length, 1);
      const launched = launches[0];
      assert.ok(same(launched.creator, expected.operator) && same(launched.hook, expected.hook) && same(launched.escrow, expected.escrow));
      assert.ok(same(await read(addresses.creatorRegistry, registryAbi, 'payoutOf', [launched.token]), expected.controller));
      const metadataEvents = events(receipt, addresses.portal, portalAbi, 'LaunchMetadata');
      assert.equal(metadataEvents.length, 1);
      const metadata = metadataEvents[0];
      assert.ok(same(metadata.token, launched.token));
      for (const field of ['imageURI', 'description', 'website', 'twitter', 'telegram']) assert.equal(metadata[field], expected.brand[field]);
      const bundleEvents = events(receipt, addresses.portal, portalAbi, 'BundleBought');
      assert.equal(bundleEvents.length, 1);
      const bought = bundleEvents[0];
      assert.ok(same(bought.token, launched.token));
      assert.equal(bought.wallets, 1n);
      assert.equal(bought.quoteIn, BigInt(expected.seedUsdcRaw));
      const received = events(receipt, launched.token, transferAbi, 'Transfer').filter(event => same(event.to, expected.treasury)).reduce((sum, event) => sum + event.value, 0n);
      assert.ok(received > 0n); assert.equal(received, bought.tokensOut);
      Object.assign(evidence, plain({ tokenAddress: launched.token, openingTokensRaw: received, creator: launched.creator, controller: expected.controller, treasury: expected.treasury, hook: launched.hook, escrow: launched.escrow, locker: launched.locker, metadata }));
    } else if (action.kind === 'trade') {
      const transfers = events(receipt, expected.currencyOut, transferAbi, 'Transfer');
      const output = transfers.reduce((sum, event) => sum + (same(event.to, expected.actor) ? event.value : 0n) - (same(event.from, expected.actor) ? event.value : 0n), 0n);
      assert.ok(output >= BigInt(expected.minimumAmountOutRaw));
      evidence.actualOutputRaw = output.toString();
    } else if (action.kind === 'lock') {
      const transfers = events(receipt, expected.token, transferAbi, 'Transfer');
      const amount = BigInt(expected.amountRaw);
      if (expected.operation === 'timed') {
        const locked = events(receipt, expected.deployment, timeLockAbi, 'Locked');
        assert.equal(locked.length, 1);
        const event = locked[0];
        assert.ok(same(event.token, expected.token) && same(event.owner, expected.owner) && same(event.depositor, expected.actor));
        assert.equal(event.unlockAt, BigInt(expected.unlockAt));
        assert.ok(event.amount > 0n && event.amount <= amount);
        const record = await read(expected.deployment, timeLockAbi, 'getLock', [event.id]);
        assert.ok(same(record.token, expected.token) && same(record.owner, expected.owner) && !record.withdrawn);
        assert.equal(record.amount, event.amount); assert.equal(BigInt(record.unlockAt), event.unlockAt);
        assert.equal(transfers.filter(item => same(item.from, expected.actor)).reduce((sum, item) => sum + item.value, 0n), amount);
        Object.assign(evidence, plain({ tokenAddress: expected.token, deployment: expected.deployment, owner: event.owner, lockId: event.id, creditedAmountRaw: event.amount, unlockAt: event.unlockAt }));
      } else if (expected.operation === 'permanent') {
        const locked = events(receipt, expected.deployment, lockVaultAbi, 'Locked');
        assert.equal(locked.length, 1);
        const event = locked[0];
        assert.ok(same(event.token, expected.token) && same(event.from, expected.actor));
        assert.ok(event.delta > 0n && event.delta <= amount);
        assert.ok(event.totalLocked >= BigInt(expected.lockedBeforeRaw) + event.delta);
        assert.ok(await read(expected.deployment, lockVaultAbi, 'locked', [expected.token]) >= event.totalLocked);
        assert.equal(transfers.filter(item => same(item.from, expected.actor)).reduce((sum, item) => sum + item.value, 0n), amount);
        Object.assign(evidence, plain({ tokenAddress: expected.token, deployment: expected.deployment, creditedAmountRaw: event.delta, lockedTotalRaw: event.totalLocked }));
      } else if (expected.operation === 'withdraw') {
        const withdrawn = events(receipt, expected.deployment, timeLockAbi, 'Withdrawn');
        assert.equal(withdrawn.length, 1);
        const event = withdrawn[0];
        assert.equal(event.id, BigInt(expected.lockId)); assert.equal(event.amount, amount);
        assert.ok(same(event.token, expected.token) && same(event.owner, expected.actor));
        const record = await read(expected.deployment, timeLockAbi, 'getLock', [event.id]);
        assert.ok(record.withdrawn && same(record.token, expected.token) && same(record.owner, expected.actor));
        const received = transfers.reduce((sum, item) => sum + (same(item.to, expected.actor) ? item.value : 0n) - (same(item.from, expected.actor) ? item.value : 0n), 0n);
        assert.ok(received > 0n && received <= amount);
        Object.assign(evidence, plain({ tokenAddress: expected.token, deployment: expected.deployment, lockId: event.id, walletReceivedAmountRaw: received }));
      } else fail('ARGUS_RECEIPT_MISMATCH', 'The lock operation is not supported.');
      evidence.operation = expected.operation;
    } else {
      if (expected.operation === 'set_split' || expected.operation === 'accept_owner') {
        const [recipients, bps] = await read(addresses.creatorRegistry, registryAbi, 'payoutSplit', [expected.token]);
        assert.deepEqual(recipients.map((recipient, index) => ({ recipient: recipient.toLowerCase(), bps: Number(bps[index]) })), expected.split.map(part => ({ ...part, recipient: part.recipient.toLowerCase() })));
      }
      if (expected.operation === 'propose_owner') assert.ok(same(await read(addresses.creatorRegistry, registryAbi, 'proposedPayout', [expected.token]), expected.proposedController));
      if (expected.operation === 'accept_owner') assert.ok(same(await read(addresses.creatorRegistry, registryAbi, 'payoutOf', [expected.token]), expected.controller));
      if (expected.operation === 'claim_fees') {
        const escrowAbi = bundle.portal8.contracts.ArgusV5PayoutEscrow.abi;
        assert.ok(same(await read(addresses.creatorRegistry, registryAbi, 'escrowOf', [expected.token]), step.to));
        const [quoteAsset, payoutAsset, controller, split] = await Promise.all([
          read(step.to, escrowAbi, 'quoteAsset'), read(step.to, escrowAbi, 'payoutAsset'),
          read(addresses.creatorRegistry, registryAbi, 'payoutOf', [expected.token]),
          read(addresses.creatorRegistry, registryAbi, 'payoutSplit', [expected.token]),
        ]);
        // Every tracked launch in this comparison uses direct USDC payouts.
        // Native Arc's precompile is not covered by the local ERC-20 fixture.
        assert.ok(same(quoteAsset, addresses.defaultQuoteAsset) && same(payoutAsset, quoteAsset));
        assert.ok(same(controller, expected.controllerBefore));
        const recipients = split[0].length ? split[0].map((recipient, index) => ({ recipient, bps: Number(split[1][index]) })) : [{ recipient: controller, bps: 10000 }];
        assert.deepEqual(recipients.map(part => ({ ...part, recipient: part.recipient.toLowerCase() })),
          expected.recipients.map(part => ({ ...part, recipient: part.recipient.toLowerCase() })));
        const claims = events(receipt, step.to, escrowAbi, 'CreatorClaimed');
        assert.ok(claims.length > 0 && claims.length <= 8);
        assert.ok(claims.every(event => same(event.to, controller) || recipients.some(part => same(event.to, part.recipient))));
        const actualOwed = claims.reduce((sum, event) => sum + event.owedQuote, 0n);
        assert.ok(actualOwed > 0n);
        const transfers = events(receipt, quoteAsset, transferAbi, 'Transfer').filter(event => same(event.from, step.to));
        assert.ok(transfers.every(event => recipients.some(part => same(event.to, part.recipient))));
        assert.equal(transfers.reduce((sum, event) => sum + event.value, 0n), actualOwed);
        let remainder = actualOwed;
        const payouts = recipients.map((part, index) => {
          const share = index === recipients.length - 1 ? remainder : actualOwed * BigInt(part.bps) / 10000n;
          remainder -= share;
          const received = transfers.filter(event => same(event.to, part.recipient)).reduce((sum, event) => sum + event.value, 0n);
          assert.equal(received, share);
          return { recipient: part.recipient, asset: quoteAsset, amountRaw: received.toString() };
        });
        Object.assign(evidence, plain({ actualCreatorFeesUsdcRaw: actualOwed, payouts, creatorClaims: claims }));
      }
      evidence.operation = expected.operation;
    }
    return evidence;
  }
  async function findSubmission(action, step) {
    if (step.hash) return step.hash;
    if (step.providerId && executor?.lookup) {
      const found = await executor.lookup({ providerId: step.providerId, account: step.from });
      if (found.hash) return found.hash;
    }
    if (mainnet) return null; // A hosted smart account has no safe EOA sender/nonce fallback.
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const start = BigInt(step.attempt.blockNumber ?? action.metadata.preparedAtBlock);
    if (head < start || head - start > 100n) return null;
    for (let number = start; number <= head; number++) {
      const block = await client.getBlock({ blockNumber: number, includeTransactions: true });
      const found = block.transactions.find(tx => same(tx.from, step.attempt.from) && tx.nonce === Number(step.attempt.nonce));
      if (found) return found.hash;
    }
    return null;
  }
  function saveProject(action) {
    if (action.kind !== 'launch' || action.status !== 'confirmed') return;
    const step = action.steps.at(-1);
    store.saveProject({ verified: true, token: step.receipt.tokenAddress, chainId: chain.id, launchActionId: action.id,
      launchTxHash: step.hash, launchBlock: step.receipt.blockNumber, operator: action.expected.operator,
      controller: action.expected.controller, treasury: action.expected.treasury, brand: action.expected.brand });
  }
  async function reconcile(id) {
    let action = store.getAction(id);
    for (const step of action.steps.filter(item => pending.has(item.status))) {
      const hash = await findSubmission(action, step);
      if (!hash) continue;
      try {
        const evidence = await verifyReceipt(action, step, hash);
        store.submitted(id, step.index, { hash, attemptId: step.attempt.id });
        action = store.confirmStep(id, step.index, evidence);
      } catch (error) {
        if (error.name === 'TransactionReceiptNotFoundError' || error.name === 'TransactionNotFoundError') continue;
        throw error;
      }
    }
    action = store.getAction(id); saveProject(action); return action;
  }
  async function reconcileTransaction({ actionId, stepIndex, transactionHash }) {
    await checkRuntime();
    const action = store.getAction(actionId);
    const step = action.steps[stepIndex];
    if (!step?.attempt?.id || !pending.has(step.status)) fail('ARGUS_RECOVERY_NOT_PENDING', 'Only an already attempted unresolved step can accept transaction evidence. No transaction was submitted.');
    if (step.hash && !same(step.hash, transactionHash)) fail('ARGUS_RECOVERY_HASH_CONFLICT', 'This step already has a different transaction hash. Its evidence cannot be replaced.');
    // Verify first: a pasted unrelated hash must not poison the durable attempt.
    const evidence = await verifyReceipt(action, step, transactionHash);
    store.submitted(action.id, step.index, { hash: transactionHash, attemptId: step.attempt.id });
    const reconciled = store.confirmStep(action.id, step.index, evidence);
    saveProject(reconciled);
    return { action: publicAction(reconciled), budget: store.budget(), coverage: { ...coverage } };
  }
  async function execute(id) {
    if (mvp && config.executionEnabled !== true) fail('ARGUS_EXECUTION_DISABLED', 'Execution is disabled in this workspace. Reading and importing do not require a wallet executor.');
    await checkRuntime();
    let action = await reconcile(id);
    if (action.status === 'cancelled') fail('ARGUS_ACTION_CANCELLED', 'This action was cancelled. Its completed steps remain recorded and its unsubmitted steps cannot be replayed.');
    if (action.status === 'confirmed') return { action: publicAction(action), budget: store.budget(), coverage: { ...coverage } };
    if (action.steps.some(step => pending.has(step.status))) fail('ARGUS_OUTCOME_UNKNOWN', 'An earlier submission is unresolved. Read this action again; do not prepare a replacement.');
    if (Date.parse(action.metadata.expiresAt) <= Date.now()) fail('ARGUS_ACTION_EXPIRED', 'The saved action expired before execution. Existing approvals remain recorded.');
    if (mainnet && (action.metadata.executionMode !== 'circle-hosted' || digest(action.terms.identity) !== digest(config.identity) || action.steps.some(step => !same(step.from, roles.operator)))) fail('ARGUS_TERMS_CHANGED', 'The saved action does not belong to this hosted mainnet pilot identity.');
    if (digest(action.terms) !== action.termsHash || digest(action.terms.roles) !== digest(roles)) fail('ARGUS_TERMS_CHANGED', 'Saved terms or configured signing roles changed.');
    if (planDigest(action) !== action.metadata.planDigest) fail('ARGUS_TERMS_CHANGED', 'Saved transaction plan changed. Restore the original journal before proceeding.');
    if (executor.preflight && !(await executor.preflight()).ready) fail('ARGUS_EXECUTOR_UNAVAILABLE', 'Complete the configured executor setup before executing this saved action.');
    if (action.kind === 'management') {
      const current = await contracts.readProject(action.expected.token);
      if (!same(current.controller, action.expected.controllerBefore)) fail('ARGUS_TERMS_CHANGED', 'Payout control changed since this action was prepared.');
      if (action.expected.operation === 'claim_fees') {
        const recipients = current.split.length ? current.split : [{ recipient: current.controller, bps: 10000 }];
        if (digest(recipients.map(part => ({ ...part, recipient: part.recipient.toLowerCase() }))) !== digest(action.expected.recipients.map(part => ({ ...part, recipient: part.recipient.toLowerCase() })))) fail('ARGUS_TERMS_CHANGED', 'Payout recipients changed since the claim was prepared.');
      }
    }
    action = store.reserveExecution(id, { resume: Boolean(action.leaseId) });
    for (const step of action.steps.filter(item => item.status === 'ready')) {
      await checkRuntime();
      if (action.kind === 'lock' && action.expected.operation === 'timed' && step.index === action.steps.length - 1) {
        const block = await client.getBlock({ blockTag: 'latest' });
        if (BigInt(action.expected.unlockAt) < block.timestamp + BigInt(MIN_LOCK_LEAD_SECONDS)) fail('ARGUS_LOCK_TIME_CHANGED', 'The approved unlock time no longer leaves the required signing margin.');
      }
      await client.call({ account: step.from, to: step.to, data: step.data, value: BigInt(step.value), ...(mainnet ? {} : { gas: BigInt(step.gas) }) });
      const attemptId = randomUUID();
      const tx = { account: step.from, to: step.to, data: step.data, value: step.value, abi: step.abi, chainId: chain.id, operationId: attemptId };
      let nonce;
      if (mainnet) {
        if (typeof executor.estimate !== 'function') fail('ARGUS_FEE_UNAVAILABLE', 'A fresh hosted Circle fee estimate is required before submission.');
        const estimate = await executor.estimate(tx);
        const raw = estimate.fees?.networkFee;
        if (estimate.ok !== true || estimate.chainId !== chain.id || !same(estimate.account, step.from) || !same(estimate.calldataHash, keccak256(step.data))
          || typeof raw !== 'string' || !/^\d+(?:\.\d{1,18})?$/.test(raw)) fail('ARGUS_FEE_UNAVAILABLE', 'Circle did not return an exact USDC network fee estimate for this saved call.');
        const estimateWei = parseUnits(raw, 18);
        const threshold = action.kind === 'launch' && step.index === action.steps.length - 1 ? 95n : 80n;
        if (estimateWei * 100n > BigInt(step.gasReserveWei) * threshold) fail('ARGUS_FEE_CHANGED', 'The fresh hosted fee estimate exceeds this action’s reserved headroom. No transaction was submitted.');
        const remainingPrincipalWei = action.steps.filter(item => item.status === 'ready').reduce((sum, item) => sum + BigInt(item.principalRaw) * 10n ** 12n, 0n);
        const remainingFeeWei = action.steps.filter(item => item.status === 'ready').reduce((sum, item) => sum + BigInt(item.gasReserveWei), 0n);
        const balance = await client.getBalance({ address: step.from, blockTag: 'pending' });
        if (typeof balance !== 'bigint' || balance < remainingPrincipalWei + remainingFeeWei)
          fail('ARGUS_BALANCE_INSUFFICIENT', 'Native USDC must cover the remaining principal and reserved fees, even when Circle estimates sponsorship.');
      } else {
        nonce = await client.getTransactionCount({ address: step.from, blockTag: 'pending' });
        if (await currentFeeFloor() > BigInt(step.maxFeePerGas)) fail('ARGUS_FEE_CHANGED', 'Current gas price or block base fee exceeds the reserved envelope. No transaction was submitted.');
        Object.assign(tx, { gas: step.gas, maxFeePerGas: step.maxFeePerGas, nonce });
      }
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
      store.beforeSubmit(id, step.index, { attemptId, from: step.from, ...(mainnet ? {} : { nonce }), blockNumber: blockNumber.toString(), leaseId: action.leaseId });
      try {
        const result = await executor.execute(tx);
        if (result.status !== 'submitted' || (!result.hash && !result.providerId)) {
          store.markUnknown(id, step.index); fail('ARGUS_OUTCOME_UNKNOWN', 'The executor did not establish submission status. Reconcile this action before proceeding.');
        }
        if (onceFault('dropSubmissionResponseOnce')) { store.markUnknown(id, step.index); fail('ARGUS_OUTCOME_UNKNOWN', 'Injected local lost response. The journal retained the attempt; use get_action to reconcile.'); }
        store.submitted(id, step.index, { ...result, attemptId });
        if (result.hash) await client.waitForTransactionReceipt({ hash: result.hash, timeout: 60_000, pollingInterval: mainnet ? 2000 : 100 });
        action = await reconcile(id);
        if (!['confirmed', 'executing'].includes(action.status)) return { action: publicAction(action), budget: store.budget(), coverage: { ...coverage } };
        if (step.index < action.steps.length - 1 && onceFault('stopAfterApprovalOnce')) return { action: publicAction(action), budget: store.budget(), coverage: { ...coverage }, interruptedAfterApproval: true };
      } catch (error) {
        const current = store.getAction(id).steps[step.index];
        if (pending.has(current.status)) store.markUnknown(id, step.index);
        throw error;
      }
    }
    action = await reconcile(id);
    return { action: publicAction(action), budget: store.budget(), coverage: { ...coverage } };
  }
  async function dispatch(name, input = {}) {
    try {
      const args = validateOperation(name, input);
      if (reads.handles(name)) return await reads.execute(name, args);
      if (mvp && ['argus_get_action', 'argus_get_project'].includes(name)) await checkRuntime();
      if (['argus_prepare_project', 'argus_prepare_management', 'argus_prepare_trade', 'argus_prepare_lock'].includes(name)) return await prepare(name, args);
      if (name === 'argus_reconcile_transaction') return await reconcileTransaction(args);
      if (name === 'argus_cancel_action') return { action: publicAction(store.cancelAction(args.actionId)), budget: store.budget(), coverage: { ...coverage } };
      if (name === 'argus_execute_action') return await execute(args.actionId);
      if (name === 'argus_get_action') return { action: publicAction(await reconcile(args.actionId)), budget: store.budget(), coverage: { ...coverage } };
      if (name === 'argus_import_project') {
        if (!mvp) fail('ARGUS_MODE_UNSUPPORTED', 'Use an independently initialized MVP workspace for project recovery.');
        const project = store.saveImportedProject(await verifyProjectImport(client, args));
        return { project, management: projectManagementLink(project.token, project.controller), coverage: { ...coverage } };
      }
      if (name === 'argus_recover_position') {
        if (!mvp) fail('ARGUS_MODE_UNSUPPORTED', 'Position recovery requires an independent MVP workspace.');
        knownProject(args.token);
        const position = await verifyPositionRecovery(client, { ...args, actor: roles.operator });
        const recovery = store.saveRecoveredPosition(position);
        return { position: recovery, inventory: store.getInventory(args.token, roles.operator),
          ...(position.lock && !same(position.lock.owner, roles.operator) ? { status: 'needs_human_signature', management: projectManagementLink(args.token, position.lock.owner, 'withdraw', { lockId: position.lock.lockId }) } : {}),
          budget: store.budget(), coverage: { ...coverage } };
      }
      if (name === 'argus_export_projects') return { manifest: exportProjectManifest(store.listProjects()), coverage: { ...coverage } };
      if (name === 'argus_list_projects') return { projects: store.listProjects().map(project => ({ ...project,
        configuredHumanIsController: same(project.controller, roles.controller), projectUrl: projectManagementLink(project.token, project.controller).url })),
        budget: store.budget(), coverage: { ...coverage }, scope: 'Saved project references only. Roles in this list were observed when saved; get_project refreshes current roles. No global discovery or historical index.' };
      if (name === 'argus_get_project') {
        const project = knownProject(args.token);
        const current = await contracts.readProject(project.token, { roles, fromBlock: project.launchBlock });
        return { project: current, launch: project, management: projectManagementLink(project.token, current.controller), coverage: { ...coverage } };
      }
      fail('ARGUS_UNKNOWN_OPERATION', 'Unknown operation.');
    } catch (error) {
      const known = error.safe || error instanceof AgentStoreError;
      const code = known || ['ARGUS_UNKNOWN_OPERATION', 'ARGUS_INVALID_ARGUMENTS'].includes(error.code) ? error.code : 'ARGUS_OPERATION_FAILED';
      return { error: { code, message: known ? error.message : 'The operation could not be verified. Inspect the existing action before retrying a mutation.',
        retryable: false }, coverage: { ...coverage } };
    }
  }
  return { catalog, dispatch, close: () => store.close(), evidence: () => ({ actions: store.listActions().map(publicAction), projects: store.listProjects(), budget: store.budget(), coverage: { ...coverage }, ...(mainnet ? { identity: config.identity } : {}) }) };
}
