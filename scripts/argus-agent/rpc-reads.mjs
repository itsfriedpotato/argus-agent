import { setTimeout as delay } from 'node:timers/promises';

const clients = new WeakMap();
const methods = ['getChainId', 'getTransaction', 'getTransactionReceipt', 'getBlock', 'getBlockNumber', 'getCode',
  'getStorageAt', 'readContract', 'getLogs', 'getBalance', 'getGasPrice', 'call'];

/** One read queue per client, shared by planning, project reads and receipt verification.
 * No retries or provider fallback. Receipt polling keeps its separate two-second cadence.
 */
export function pacedReads(client, intervalMs = 250) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 1000) {
    throw Object.assign(new Error('Invalid RPC read interval.'), { code: 'ARGUS_RPC_PACING_INVALID', safe: true });
  }
  const existing = clients.get(client);
  if (existing) return existing;
  if (intervalMs === 0) return client;
  let nextAt = 0; let tail = Promise.resolve();
  const reads = Object.fromEntries(methods.map(method => [method, (...args) => {
    const request = tail.then(async () => {
      const wait = nextAt - Date.now();
      if (wait > 0) await delay(wait);
      nextAt = Date.now() + intervalMs;
      return client[method](...args);
    });
    tail = request.catch(() => {});
    return request;
  }]));
  const wrapped = new Proxy(client, { get(target, property, receiver) {
    return Object.hasOwn(reads, property) && typeof target[property] === 'function' ? reads[property] : Reflect.get(target, property, receiver);
  } });
  clients.set(client, wrapped); clients.set(wrapped, wrapped);
  return wrapped;
}
