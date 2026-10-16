// Hosted Circle transport compatibility only; the installed package stays untouched.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const hostedUpstream = Object.freeze({
  package: '@circle-fin/cli', version: '1.1.4',
  sha256: '89f8610b586ca929c3419779405b59618c60be10836bc4428d21c75a7c18f6a4',
});
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function patchHostedSource(original) {
  if (sha256(original) !== hostedUpstream.sha256) throw new Error('Expected unmodified official @circle-fin/cli 1.1.4 source');
  let patched = original;
  function replace(from, to) {
    if (patched.split(from).length !== 2) throw new Error('Hosted patch anchor must occur exactly once');
    patched = patched.replace(from, to);
  }
  // The derived entry lives beside node_modules; retain the official version lookup.
  replace('join3(currentDir, "..", "package.json")', 'join3(currentDir, "node_modules", "@circle-fin", "cli", "package.json")');
  replace('    "--idempotency-key",\n    "--amount",', '    "--idempotency-key",\n    "--call-data",\n    "--amount",');
  replace('  --contract <addr>          Contract address (required)\n  --amount <value>', '  --contract <addr>          Contract address (required)\n  --call-data <hex>          Exact calldata instead of ABI arguments (Argus hosted ARC compatibility)\n  --amount <value>');
  replace('  const abiFunctionSignature = pos[0];\n  if (!abiFunctionSignature) {', `  const abiFunctionSignature = pos[0];
  const callData = readFlagValue(args2, "--call-data");
  if (args2.includes("--call-data") && (args2.filter(value => value === "--call-data").length !== 1
      || typeof callData !== "string" || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(callData)
      || pos.length !== 0 || blockchain !== "ARC")) {
    outputError("Raw calldata requires one valid hex value, no ABI arguments, and chain ARC.", args2, "INVALID_ARGUMENT");
    process.exitCode = 1;
    return;
  }
  if (!abiFunctionSignature && !callData) {`);
  replace('  if (resolved.wallet.type === "local") {\n    if (estimate) {\n      await handleLocalExecuteEstimate(', `  if (resolved.wallet.type === "local") {
    if (callData) {
      outputError("Raw calldata is restricted to hosted Circle Agent Wallets.", args2, "INVALID_ARGUMENT");
      process.exitCode = 1;
      return;
    }
    if (estimate) {
      await handleLocalExecuteEstimate(`);
  replace('async function handleAgentExecute(wallet, env, blockchain, contractAddress, abiFunctionSignature, abiParameters, value, estimate, args2) {\n  const proxyUrl', `async function handleAgentExecute(wallet, env, blockchain, contractAddress, abiFunctionSignature, abiParameters, value, estimate, args2) {
  const callData = readFlagValue(args2, "--call-data");
  const call = callData ? { callData } : { abiFunctionSignature, abiParameters: abiParameters.length > 0 ? abiParameters : void 0 };
  const proxyUrl`);
  replace('        contractAddress,\n        abiFunctionSignature,\n        abiParameters: abiParameters.length > 0 ? abiParameters : void 0,\n        amount: value !== "0" ? value : void 0', '        contractAddress,\n        ...call,\n        amount: value !== "0" ? value : void 0');
  replace('    idempotencyKey,\n    contractAddress,\n    abiFunctionSignature,\n    abiParameters: abiParameters.length > 0 ? abiParameters : void 0,\n    amount: value !== "0" ? value : void 0', '    idempotencyKey,\n    contractAddress,\n    ...call,\n    amount: value !== "0" ? value : void 0');
  return patched;
}

export function buildHostedRuntime(root) {
  const upstreamPath = join(root, 'node_modules/@circle-fin/cli/dist/index.js');
  const packageInfo = JSON.parse(readFileSync(join(root, 'node_modules/@circle-fin/cli/package.json'), 'utf8'));
  if (packageInfo.name !== hostedUpstream.package || packageInfo.version !== hostedUpstream.version) throw new Error('Unexpected Circle package identity');
  const original = readFileSync(upstreamPath, 'utf8');
  const patched = patchHostedSource(original);
  const manifest = {
    patchId: 'argus-hosted-calldata-v1', upstreamPackage: hostedUpstream.package, upstreamVersion: hostedUpstream.version,
    upstreamSha256: sha256(original), patchedSha256: sha256(patched), hostedOnly: true,
    changes: ['Expose documented raw callData for hosted ARC estimate and execution', 'Reject raw calldata for local wallets and other chains'],
    unchanged: ['Hosted authentication and MPC challenge approval', 'Circle service policies', 'UUID idempotency transport', 'MEDIUM fee selection', 'All local OWS behavior'],
    limitations: ['Derived CLI transport, not stock CLI compatibility', 'No exact gas or fee ceiling', 'No independent calldata policy enforcement'],
    documentation: [
      'https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-transaction-estimate-fee',
      'https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge',
    ],
  };
  writeFileSync(join(root, 'circle-hosted.mjs'), patched, { mode: 0o600 });
  writeFileSync(join(root, 'hosted-patch.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../../.cache/argus-agent/circle-runtime/', import.meta.url)));
  console.log(JSON.stringify(buildHostedRuntime(root), null, 2));
}
