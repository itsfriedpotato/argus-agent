import { readFileSync } from 'node:fs';
import { decodeEventLog, getAddress, zeroAddress } from 'viem';
import { PORTALS } from './generated/addresses.mjs';
import { erc20Abi } from './generated/abis.mjs';
import { findLaunch, lineState, tokenCreatedEvent } from './lines.mjs';

const bundle = JSON.parse(readFileSync(new URL('./vendor/argus-v4.json', import.meta.url), 'utf8')).portal8;
const addresses = bundle.addresses;
const portalAbi = bundle.contracts.ArgusV5Portal.abi;
const registryAbi = bundle.contracts.ArgusV5CreatorRegistry.abi;
const tokenAbi = bundle.contracts.ArgusV5RewardedToken.abi;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const plain = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const fail = message => { throw Object.assign(new Error(message), { code: 'ARGUS_PROJECT_UNVERIFIED', safe: true }); };
const hash = value => /^0x[\da-f]{64}$/i.test(value ?? '');
const events = (receipt, name) => receipt.logs.filter(log => same(log.address, addresses.portal) && !log.removed).flatMap(log => {
  try { const event = decodeEventLog({ abi: portalAbi, data: log.data, topics: log.topics, strict: true }); return event.eventName === name ? [event.args] : []; } catch { return []; }
});
/** TokenCreated from one of the Portals 1-7, decoded by that Portal's own line. Anyone can emit the topic; only these emitters count. */
const olderLaunches = receipt => receipt.logs.filter(log => !log.removed).flatMap(log => {
  const portal = PORTALS.find(item => same(item.address, log.address));
  if (!portal) return [];
  try {
    const event = decodeEventLog({ abi: [tokenCreatedEvent(portal.line)], data: log.data, topics: log.topics, strict: true });
    return event.eventName === 'TokenCreated' ? [{ portal: getAddress(portal.address), line: portal.line, ...event.args }] : [];
  } catch { return []; }
});

export function projectManagementLink(token, requiredSigner, operation = 'manage_creator_fees', { lockId } = {}) {
  const projectUrl = `https://argus.world/token/${getAddress(token)}`;
  const lockOperation = ['timed', 'permanent', 'withdraw'].includes(operation);
  const instructions = lockOperation ? operation === 'withdraw'
    ? 'Open Argus Lock and connect the actual lock owner wallet. Find the supplied lock ID and withdraw only after its on-chain unlock time.'
    : 'Open Argus Lock and connect the wallet holding the tokens. Choose the requested lock type and review its amount, beneficiary and duration.'
    : ['buy', 'sell'].includes(operation)
      ? 'Open the Argus project trade panel and connect the wallet holding the input funds. Review the amount, slippage and transaction before signing.'
      : 'Open the Argus project payout controls and connect the required controller wallet. Creator-fee control is separate from token custody and the historical launch creator.';
  return { url: lockOperation ? 'https://argus.world/lock' : projectUrl, projectUrl,
    requiredSigner: requiredSigner ? getAddress(requiredSigner) : null, operation, ...(lockId !== undefined ? { lockId: String(lockId) } : {}), instructions };
}

/** Bounded receipt import; no historic log scan, signing, balance grants or journal replay. */
export async function verifyProjectImport(client, { launchTxHash, token: requestedToken }) {
  if (!hash(launchTxHash)) throw Object.assign(new Error('Supply the confirmed launch transaction hash to import this token. No global RPC scan is performed.'), { code: 'ARGUS_LAUNCH_RECEIPT_REQUIRED', safe: true });
  if (await client.getChainId() !== 5042) fail('Project recovery requires Arc mainnet chain 5042.');
  const receipt = await client.getTransactionReceipt({ hash: launchTxHash });
  if (receipt.status !== 'success' || !same(receipt.transactionHash, launchTxHash) || !hash(receipt.blockHash) || typeof receipt.blockNumber !== 'bigint') fail('The launch receipt must be successful and mined.');
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!same(canonical.hash, receipt.blockHash) || canonical.number !== receipt.blockNumber) fail('The launch receipt does not belong to the canonical block.');
  const launched = events(receipt, 'Launched').filter(event => !requestedToken || same(event.token, requestedToken));
  if (!launched.length) {
    const older = olderLaunches(receipt).filter(event => !requestedToken || same(event.token, requestedToken));
    if (older.length === 1) return verifyOlderImport(client, receipt, launchTxHash, older[0]);
  }
  if (launched.length !== 1) fail('Select one Argus launch token from this receipt.');
  const launch = launched[0];
  const token = getAddress(launch.token);
  if (same(token, zeroAddress) || same(launch.creator, zeroAddress)) fail('The receipt does not identify a valid launch.');
  const metadata = events(receipt, 'LaunchMetadata').filter(event => same(event.token, token));
  if (metadata.length !== 1) fail('The receipt must contain exactly one Portal8 metadata event for this launch.');
  const observed = await client.getBlock({ blockTag: 'latest' });
  if (typeof observed.number !== 'bigint' || observed.number < receipt.blockNumber || !hash(observed.hash)) fail('A current canonical snapshot is required.');
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: observed.number });
  const liveRegistry = await read(addresses.portal, portalAbi, 'creatorRegistry');
  if (!same(liveRegistry, addresses.creatorRegistry)) fail('The Portal creator registry differs from the supported deployment.');
  const record = await read(addresses.portal, portalAbi, 'launches', [token]);
  if (!same(record[0], launch.hook) || !same(record[1], launch.escrow) || !same(record[2], launch.locker) ||
      record[3] !== launch.positionId || Number(record[4]) !== Number(launch.tickStart) || Number(record[5]) !== Number(launch.tickBond)) fail('The Portal launch state does not match its canonical event.');
  const [controller, proposed, escrow, split, name, symbol] = await Promise.all([
    read(addresses.creatorRegistry, registryAbi, 'payoutOf', [token]), read(addresses.creatorRegistry, registryAbi, 'proposedPayout', [token]),
    read(addresses.creatorRegistry, registryAbi, 'escrowOf', [token]), read(addresses.creatorRegistry, registryAbi, 'payoutSplit', [token]),
    read(token, tokenAbi, 'name'), read(token, tokenAbi, 'symbol'),
  ]);
  if (same(controller, zeroAddress) || !same(escrow, launch.escrow) || split[0].length !== split[1].length) fail('Current creator registry state does not match the supported launch.');
  // Guard both observations against a reorg during the bounded import.
  const [finalLaunchBlock, finalObservedBlock] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlock({ blockNumber: observed.number }),
  ]);
  if (!same(finalLaunchBlock.hash, receipt.blockHash) || !same(finalObservedBlock.hash, observed.hash)) fail('Chain observations changed during recovery. Retry the same import.');
  const brandMetadata = Object.fromEntries(['imageURI', 'website', 'twitter', 'telegram', 'description'].map(field => [field, metadata[0][field]]));
  return plain({ verified: true, source: 'canonical-launch-receipt', chainId: 5042, token,
    launchTxHash: launchTxHash.toLowerCase(), launchBlock: receipt.blockNumber, launchBlockHash: receipt.blockHash,
    portal: addresses.portal, creatorRegistry: addresses.creatorRegistry, operator: getAddress(launch.creator),
    historicalCreator: getAddress(launch.creator), controller: getAddress(controller), proposedController: same(proposed, zeroAddress) ? null : getAddress(proposed),
    hook: launch.hook, escrow: launch.escrow, locker: launch.locker, treasury: null,
    custodyStatus: 'Current holdings and original opening-buy recipients are not inferred from a project reference.',
    split: split[0].map((recipient, index) => ({ recipient, bps: Number(split[1][index]) })), brand: { name, symbol, ...brandMetadata },
    observedBlockNumber: observed.number, observedBlockHash: observed.hash,
    projectUrl: projectManagementLink(token, controller).url,
    authorityNote: 'Historical creator records the launch sender. Controller is current creator-fee authority. Import grants neither signing authority nor spendable inventory.' });
}

/** A Portals 1-7 launch, from its canonical TokenCreated and the Portal's own current record. */
async function verifyOlderImport(client, receipt, launchTxHash, event) {
  const token = getAddress(event.token);
  if (same(event.creator, zeroAddress)) fail('The receipt does not identify a valid launch.');
  const observed = await client.getBlock({ blockTag: 'latest' });
  if (typeof observed.number !== 'bigint' || observed.number < receipt.blockNumber || !hash(observed.hash)) fail('A current canonical snapshot is required.');
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: observed.number });
  const launch = await findLaunch(read, token);
  if (!launch || launch.line === 'v5' || !same(launch.portal, event.portal) || !same(launch.record.creator, event.creator)
      || (launch.line === 'hooked' ? !same(launch.record.poolId, event.poolId) : !same(launch.record.pool, event.pool))) fail('The Portal launch state does not match its canonical event.');
  const state = await lineState(read, launch);
  const [name, symbol] = await Promise.all([read(token, erc20Abi, 'name'), read(token, erc20Abi, 'symbol')]);
  const [finalLaunchBlock, finalObservedBlock] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlock({ blockNumber: observed.number }),
  ]);
  if (!same(finalLaunchBlock.hash, receipt.blockHash) || !same(finalObservedBlock.hash, observed.hash)) fail('Chain observations changed during recovery. Retry the same import.');
  return plain({ verified: true, source: 'canonical-launch-receipt', chainId: 5042, token,
    launchTxHash: launchTxHash.toLowerCase(), launchBlock: receipt.blockNumber, launchBlockHash: receipt.blockHash,
    portal: launch.portal, line: launch.line, generation: launch.generation, creatorRegistry: null,
    operator: getAddress(event.creator), historicalCreator: getAddress(event.creator), controller: state.payee, proposedController: null,
    hook: state.hook, splitter: state.splitter, escrow: null, locker: state.locker, pool: state.pool, processor: state.processor, treasury: null,
    custodyStatus: 'Current holdings and original opening-buy recipients are not inferred from a project reference.',
    split: [], brand: { name, symbol, imageURI: event.imageURI, website: event.website, twitter: event.twitter, telegram: event.telegram, description: '' },
    observedBlockNumber: observed.number, observedBlockHash: observed.hash,
    projectUrl: projectManagementLink(token, state.payee).url,
    authorityNote: 'A Portals 1-7 launch pays creator fees to its own creator address, which nobody can change. Import grants neither signing authority nor spendable inventory.' });
}

export function exportProjectManifest(projects) {
  return { format: 'argus-projects', version: 1, chainId: 5042,
    projects: projects.map(project => ({ token: project.token, launchTxHash: project.launchTxHash, launchBlock: project.launchBlock })),
    recovery: 'Import each launchTxHash and token in the new workspace. All references are reverified on-chain; this manifest carries no wallet credentials, permissions or pending actions.' };
}

/** Recover only a known project's current Circle holdings and explicitly identified lock. */
export async function verifyPositionRecovery(client, { token: inputToken, actor: inputActor, lockId }) {
  const token = getAddress(inputToken), actor = getAddress(inputActor);
  if (await client.getChainId() !== 5042) fail('Position recovery requires Arc mainnet chain 5042.');
  const block = await client.getBlock({ blockTag: 'latest' });
  if (typeof block.number !== 'bigint' || !hash(block.hash)) fail('A canonical position snapshot is required.');
  const read = (address, abi, functionName, args) => client.readContract({ address, abi, functionName, args, blockNumber: block.number });
  const launch = await findLaunch(read, token);
  if (!launch) fail('Only a token launched by an Argus Portal can be recovered.');
  const balance = await read(token, erc20Abi, 'balanceOf', [actor]);
  if (typeof balance !== 'bigint' || balance < 0n) fail('The token balance could not be verified.');
  let lock;
  if (lockId !== undefined) {
    const { CURRENT_TIME_LOCK } = await import('./locks.mjs');
    const { parseAbi } = await import('viem');
    const abi = parseAbi(['struct Lock { address token; uint64 unlockAt; bool withdrawn; address owner; uint64 lockedAt; uint256 amount; }', 'function getLock(uint256 id) view returns (Lock)']);
    const value = await read(CURRENT_TIME_LOCK, abi, 'getLock', [BigInt(lockId)]);
    if (!same(value.token, token) || same(value.owner, zeroAddress) || typeof value.amount !== 'bigint' || value.amount <= 0n || value.withdrawn) fail('The supplied lock is absent, withdrawn or belongs to a different token.');
    lock = { deployment: CURRENT_TIME_LOCK, lockId: BigInt(lockId).toString(), token, owner: getAddress(value.owner), amountRaw: value.amount, unlockAt: value.unlockAt, withdrawn: false };
  }
  const final = await client.getBlock({ blockNumber: block.number });
  if (!same(final.hash, block.hash)) fail('The position snapshot changed during recovery. Retry the same read.');
  return plain({ verified: true, source: 'canonical-position-snapshot', chainId: 5042, token, actor,
    balanceRaw: balance, observedBlockNumber: block.number, observedBlockHash: block.hash, ...(lock ? { lock } : {}),
    scope: 'This is current token inventory, not a launch replay, full history, profit calculation or a new USDC spending allowance.' });
}
