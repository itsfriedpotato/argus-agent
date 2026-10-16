import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http } from 'viem';
import { buildAtomicBatch } from '../scripts/argus-agent/batch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const binaryName = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
const anvil = [process.env.ARGUS_TEST_ANVIL,
  join(root, '.cache/argus-agent/test-runtime/anvil', binaryName),
  ...(process.env.PATH ?? '').split(delimiter).map(directory => join(directory, binaryName))]
  .find(path => path && existsSync(path));
let solc;
for (const path of [process.env.ARGUS_TEST_SOLC, join(root, '.cache/argus-agent/test-runtime/solc/node_modules/solc'), 'solc']) {
  if (!path) continue;
  let resolved;
  try { resolved = require.resolve(path); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    continue;
  }
  // A present but broken runtime must fail, not be mistaken for an absent one.
  solc = require(resolved);
  break;
}
const missingRuntime = !anvil || !solc ? 'Requires local Anvil and solc; use ARGUS_TEST_ANVIL / ARGUS_TEST_SOLC or the cached runtimes in .cache/argus-agent/test-runtime.' : false;

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('local EVM fixture: one atomic trade and complete rollback when its last call fails', { skip: missingRuntime, timeout: 30_000 }, async t => {
  const source = readFileSync(new URL('./fixtures/ArgusAtomicTrade.sol', import.meta.url), 'utf8');
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'ArgusAtomicTrade.sol': { content: source } },
    settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  assert.deepEqual((compiled.errors ?? []).filter(error => error.severity === 'error'), []);
  const contracts = compiled.contracts['ArgusAtomicTrade.sol'];
  const directory = mkdtempSync(join(tmpdir(), 'argus-batch-evm-'));
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  const node = spawn(anvil, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--accounts', '2',
    '--hardfork', 'shanghai', '--silent'], {
    cwd: directory, env: { PATH: process.env.PATH ?? '', HOME: directory, USERPROFILE: directory, TMPDIR: directory },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let launchError;
  let diagnostics = '';
  node.once('error', error => { launchError = error; });
  node.stderr.on('data', chunk => { diagnostics = `${diagnostics}${chunk}`.slice(-4000); });
  t.after(async () => {
    if (node.exitCode === null && !launchError) {
      const exited = once(node, 'exit');
      node.kill('SIGTERM');
      const stopped = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
      if (!stopped) { node.kill('SIGKILL'); await exited; }
    }
    rmSync(directory, { recursive: true, force: true });
  });

  const chain = { id: 31337, name: 'Argus isolated batch fixture', nativeCurrency: { name: 'Fixture ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } } };
  const client = createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: 1000 }), pollingInterval: 20 });
  let connected = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    assert.equal(node.exitCode, null, diagnostics || 'Anvil exited before the local proof started.');
    try { assert.equal(await client.getChainId(), 31337); connected = true; break; } catch { await delay(25); }
  }
  assert.ok(connected, 'The isolated loopback node must start; an available runtime cannot silently skip this proof.');
  assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i);
  const [owner, recipient] = await client.request({ method: 'eth_accounts' });
  const wallet = createWalletClient({ account: owner, chain, transport: http(url, { retryCount: 0 }) });
  const deployed = {};
  async function deploy(name, args = []) {
    const contract = contracts[name];
    const hash = await wallet.deployContract({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    deployed[receipt.contractAddress.toLowerCase()] = contract.abi;
    return receipt.contractAddress;
  }
  const account = await deploy('AtomicTradeAccountFixture');
  const input = await deploy('AtomicTradeTokenFixture');
  const output = await deploy('AtomicTradeTokenFixture');
  const permit = await deploy('AtomicTradePermitFixture');
  const router = await deploy('AtomicTradeRouterFixture', [permit, output]);
  const tokenAbi = contracts.AtomicTradeTokenFixture.abi;
  const permitAbi = contracts.AtomicTradePermitFixture.abi;
  const routerAbi = contracts.AtomicTradeRouterFixture.abi;
  const minted = await wallet.writeContract({ address: input, abi: tokenAbi, functionName: 'mint', args: [account, 1000n] });
  assert.equal((await client.waitForTransactionReceipt({ hash: minted })).status, 'success');
  const initial = await client.request({ method: 'evm_snapshot' });
  const deadline = (await client.getBlock()).timestamp + 600n;
  const call = (to, abi, functionName, args) => ({ to, value: '0', data: encodeFunctionData({ abi, functionName, args }) });
  const plan = minimumOutput => buildAtomicBatch({ account, steps: [
    call(input, tokenAbi, 'approve', [permit, 100n]),
    call(permit, permitAbi, 'approve', [input, router, 100n, Number(deadline)]),
    call(router, routerAbi, 'swap', [input, recipient, 100n, minimumOutput]),
  ] });
  const read = (address, abi, functionName, args) => client.readContract({ address, abi, functionName, args });
  const state = async () => ({
    tokenAllowance: await read(input, tokenAbi, 'allowance', [account, permit]),
    permitAllowance: await read(permit, permitAbi, 'allowance', [account, input, router]),
    inputBalance: await read(input, tokenAbi, 'balanceOf', [account]),
    routerBalance: await read(input, tokenAbi, 'balanceOf', [router]),
    outputBalance: await read(output, tokenAbi, 'balanceOf', [recipient]),
  });

  await t.test('two approvals and the swap settle in one transaction with the account as sender', async () => {
    const before = await client.getTransactionCount({ address: owner });
    const batch = plan(200n);
    assert.equal(batch.batchCalls.length, 3);
    const hash = await wallet.sendTransaction({ to: batch.to, data: batch.data, value: BigInt(batch.value) });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    assert.equal(await client.getTransactionCount({ address: owner }), before + 1);
    const events = receipt.logs.map(log => decodeEventLog({ abi: deployed[log.address.toLowerCase()], data: log.data, topics: log.topics }));
    assert.deepEqual(events.map(event => event.eventName), ['Approval', 'Approval', 'Transfer', 'Swap']);
    assert.equal(events[0].args.owner.toLowerCase(), account.toLowerCase());
    assert.equal(events[1].args.owner.toLowerCase(), account.toLowerCase());
    assert.equal(events[3].args.account.toLowerCase(), account.toLowerCase());
    assert.equal(events[3].args.recipient.toLowerCase(), recipient.toLowerCase());
    assert.deepEqual(await state(), { tokenAllowance: 0n, permitAllowance: [0n, Number(deadline)],
      inputBalance: 900n, routerBalance: 100n, outputBalance: 200n });
  });

  await t.test('a failed last call rolls back both approvals, the input transfer and every log', async () => {
    assert.equal(await client.request({ method: 'evm_revert', params: [initial] }), true);
    const before = await state();
    const batch = plan(201n);
    await assert.rejects(client.call({ account: owner, to: batch.to, data: batch.data }), /minimum output/);
    // Explicit gas submits a reverting fixture transaction rather than stopping
    // at estimation, so the assertions concern mined EVM rollback.
    const hash = await wallet.sendTransaction({ to: batch.to, data: batch.data, value: 0n, gas: 1_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'reverted');
    assert.equal(receipt.logs.length, 0);
    assert.deepEqual(await state(), before);
  });
  t.diagnostic('Fixture-only local EVM proof. Does not establish Circle hosted acceptance, account authentication, Arc native USDC, live router pricing, sponsorship or mainnet timing.');
});
