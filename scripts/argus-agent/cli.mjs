#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 64 * 1024;
const usage = 'node scripts/argus-agent/cli.mjs <operation|tools> [--json <object> | --input <json-file|->]';
const failure = (code, message) => ({ error: { code, message } });
export const requestFailure = () => failure('ARGUS_REQUEST_FAILED',
  'Argus could not complete this request. Inspect the original action status before retrying an operation.');
export const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);

export async function loadConfiguredAgent(configPath = process.env.ARGUS_AGENT_CONFIG) {
  if (typeof configPath !== 'string' || !isAbsolute(configPath)) {
    throw new Error('ARGUS_AGENT_CONFIG must be an absolute config file path.');
  }
  const { readPrivateJson } = await import('./private-files.mjs');
  if (readPrivateJson(configPath).mode === 'mainnet-mvp') {
    const { createMvpAgentFromConfig } = await import('./mvp.mjs');
    return createMvpAgentFromConfig(configPath);
  }
  const { createArgusAgentFromConfig } = await import('./sdk.mjs');
  return createArgusAgentFromConfig(configPath);
}

function parseInput(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error('Input exceeds 64 KiB.');
  // Windows PowerShell 5.1 pipes and its UTF-8 files start with a byte order mark.
  const value = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Input must be a JSON object.');
  return value;
}

async function readInput(source, stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of source === '-' ? stdin : createReadStream(source)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Input exceeds 64 KiB.');
    chunks.push(buffer);
  }
  return parseInput(Buffer.concat(chunks).toString('utf8'));
}

// Engine dispatch owns schemas, policy, execution and durable action state.
export async function runCli(argv, { agent, stdin = process.stdin, write = text => process.stdout.write(text), configPath = process.env.ARGUS_AGENT_CONFIG } = {}) {
  let activeAgent = agent;
  let result;
  try {
    if (argv.length === 1 && argv[0] === '--help') {
      result = { usage, configuration: 'Set ARGUS_AGENT_CONFIG to an absolute config file path. Use tools to discover current operation schemas.' };
    } else if (!(argv.length === 1 || (argv.length === 3 && ['--input', '--json'].includes(argv[1]))) || argv[0].startsWith('-')) {
      result = failure('ARGUS_INVALID_INPUT', usage);
    } else {
      let args = {};
      if (argv.length === 3) {
        try { args = argv[1] === '--json' ? parseInput(argv[2]) : await readInput(argv[2], stdin); }
        catch { result = failure('ARGUS_INVALID_INPUT', 'Input must be a readable JSON object of at most 64 KiB.'); }
      }
      if (!result) {
        if (!activeAgent && (typeof configPath !== 'string' || !isAbsolute(configPath))) {
          result = failure('ARGUS_CONFIGURATION', 'Set ARGUS_AGENT_CONFIG to an absolute config file path.');
        } else {
          activeAgent ??= await loadConfiguredAgent(configPath);
          result = argv[0] === 'tools' ? { tools: activeAgent.catalog } : await activeAgent.dispatch(argv[0], args);
        }
      }
    }
  } catch { result = requestFailure(); }
  finally {
    try { await activeAgent?.close?.(); }
    catch { result = requestFailure(); }
  }
  write(`${json(result)}\n`);
  return result?.error ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
