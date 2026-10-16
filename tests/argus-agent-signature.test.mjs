import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyCircleTransactionSignature } from '../scripts/argus-agent/sdk.mjs';

async function signedFixture() {
  const account = privateKeyToAccount(generatePrivateKey());
  const serialized = await account.signTransaction({ type: 'eip1559', chainId: 5042, nonce: 7,
    to: '0x2222222222222222222222222222222222222222', value: 0n, data: '0x12345678', gas: 150000n,
    maxFeePerGas: 100n, maxPriorityFeePerGas: 0n,
    accessList: [{ address: '0x3333333333333333333333333333333333333333', storageKeys: [`0x${'11'.repeat(32)}`] }] });
  const parsed = parseTransaction(serialized);
  return { transaction: { ...parsed, input: parsed.data, hash: keccak256(serialized), from: account.address }, address: account.address };
}

test('signature evidence reconstructs EIP-1559 hash and signer including the access list', async () => {
  const { transaction: tx, address } = await signedFixture();
  assert.deepEqual(await verifyCircleTransactionSignature(tx, tx.hash, address), { verified: true, type: 'eip1559', recoveredAddress: address, transactionHash: tx.hash });
  const withoutParity = { ...tx, yParity: undefined, v: BigInt(tx.yParity) + 27n };
  assert.equal((await verifyCircleTransactionSignature(withoutParity, tx.hash, address)).verified, true);
});

test('valid signature with an omitted leading zero nibble in an RPC quantity keeps the same hash and signer', async () => {
  // Public signed fixture from a disposable, unfunded key; no key is retained.
  const serialized = '0x02f8698213b2058064830249f0942222222222222222222222222222222222222222808412345678c001a0e3cd1a4220deac8339b895d45f4f0bfbf55194ccc23e170851fb4106a0e7dd6ca0058c0cf5945e4e5a9d987306bde56ef45343d73364faa71342defae96e99ff91';
  const from = '0x61d4BaFb5d5CeB2111aC26F6e59d040b507a18E8';
  const hash = '0x753edccd1820cc4d589361c391298085e5fe2e8071066ebc5a3276d8010d3b8f';
  const parsed = parseTransaction(serialized);
  const padded = { ...parsed, input: parsed.data, from, hash };
  const quantity = { ...padded, r: `0x${BigInt(parsed.r).toString(16)}`, s: `0x${BigInt(parsed.s).toString(16)}` };
  assert.equal(quantity.s.length, 65);
  assert.equal(keccak256(serialized), hash);
  const expected = { verified: true, type: 'eip1559', recoveredAddress: from, transactionHash: hash };
  assert.deepEqual(await verifyCircleTransactionSignature(padded, hash, from), expected);
  assert.deepEqual(await verifyCircleTransactionSignature(quantity, hash, from), expected);
});

test('signature verification rejects any changed signed transaction field or reported hash', async () => {
  const { transaction: tx, address } = await signedFixture();
  for (const changes of [{ input: '0x12345679' }, { value: 1n }, { nonce: 8 }, { gas: 150001n }, { maxFeePerGas: 101n },
    { maxPriorityFeePerGas: 1n }, { chainId: 1 }, { to: address }, { accessList: [] }, { hash: `0x${'ff'.repeat(32)}` }]) {
    await assert.rejects(() => verifyCircleTransactionSignature({ ...tx, ...changes }, tx.hash, address), { code: 'ARGUS_SIGNATURE_MISMATCH' });
  }
  await assert.rejects(() => verifyCircleTransactionSignature(tx, `0x${'fe'.repeat(32)}`, address), { code: 'ARGUS_SIGNATURE_MISMATCH' });
});

test('signature verification rejects valid signatures from another actor and zero or absent signatures', async () => {
  const { transaction: tx, address } = await signedFixture();
  const anotherAddress = '0x4444444444444444444444444444444444444444';
  await assert.rejects(() => verifyCircleTransactionSignature(tx, tx.hash, anotherAddress), { code: 'ARGUS_SIGNATURE_MISMATCH' });
  await assert.rejects(() => verifyCircleTransactionSignature({ ...tx, from: anotherAddress }, tx.hash, address), { code: 'ARGUS_SIGNATURE_MISMATCH' });
  for (const changes of [{ type: 'legacy' }, { r: undefined }, { s: `0x${'00'.repeat(32)}` }, { s: '0x0' }, { r: '0x01' }, { r: `0x1${'00'.repeat(32)}` }, { r: '0x' }, { yParity: 2 }, { yParity: undefined, v: 99n }]) {
    await assert.rejects(() => verifyCircleTransactionSignature({ ...tx, ...changes }, tx.hash, address), { code: 'ARGUS_SIGNATURE_MISMATCH' });
  }
});
