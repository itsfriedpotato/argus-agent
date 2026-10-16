import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, zeroAddress } from 'viem';
import { buildAtomicBatch, CIRCLE_BATCH_ABI } from '../scripts/argus-agent/batch.mjs';

const account = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const call = (data = '0x12345678') => ({ to: target, value: '0', data });

test('one to four calls become exactly one self-targeted zero-value batch', () => {
  for (let length = 1; length <= 4; length++) {
    const steps = Array.from({ length }, (_, index) => ({ ...call(`0x1234567${index}`), label: `Call ${index}` }));
    const batch = buildAtomicBatch({ account, steps });
    const decoded = decodeFunctionData({ abi: CIRCLE_BATCH_ABI, data: batch.data });
    assert.equal(batch.to, account); assert.equal(batch.value, '0'); assert.equal(decoded.functionName, 'executeBatch');
    assert.deepEqual(decoded.args[0], steps.map(step => ({ target: step.to, value: 0n, data: step.data })));
    assert.deepEqual(batch.batchCalls, steps);
    steps[0].data = '0x99999999'; assert.notEqual(batch.batchCalls[0].data, steps[0].data);
    assert.ok(Object.isFrozen(batch) && Object.isFrozen(batch.batchCalls) && Object.isFrozen(batch.batchCalls[0]));
  }
});

test('batch construction refuses invalid bounds, self-targets, nested batches and native value', () => {
  const nested = buildAtomicBatch({ account, steps: [call()] });
  for (const input of [
    {}, { account: zeroAddress, steps: [call()] }, { account, steps: [] }, { account, steps: Array.from({ length: 5 }, () => call()) },
    { account, steps: [{ ...call(), to: account }] }, { account, steps: [{ ...call(), to: zeroAddress }] },
    { account, steps: [{ ...call(), value: '1' }] }, { account, steps: [{ ...call(), value: '-1' }] },
    { account, steps: [{ ...call(), data: '0x123' }] }, { account, steps: [{ ...call(), data: '0x' }] },
    { account, steps: [{ ...call(), data: nested.data }] }, { account, steps: [{ ...call(), label: 7 }] },
    { account, steps: [call(`0x${'00'.repeat(131072)}`)] },
  ]) assert.throws(() => buildAtomicBatch(input), { code: 'ARGUS_INVALID_BATCH' });
});
