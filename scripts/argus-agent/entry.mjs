#!/usr/bin/env node
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultConfig, doctor, installCircle, parseFlags, runCircle, setExecution, setupWorkspace } from './onboarding.mjs';
import { json, runCli } from './cli.mjs';

const setupOptions = ['--home', '--controller', '--circle-wallet', '--budget', '--rpc', '--treasury', '--service-url', '--service-token-file', '--circle-cli', '--circle-home'];
export async function runEntry(argv, { write = text => process.stdout.write(text) } = {}) {
  const [command, ...args] = argv;
  let result;
  try {
    if (!command || ['help', '--help', '-h'].includes(command)) result = { name: 'Argus for Agents', version: '0.2.0',
      usage: ['argus-agent circle-setup [--home DIRECTORY]', 'argus-agent circle [--home DIRECTORY] CIRCLE_COMMAND [ARGUMENTS]',
        'argus-agent setup --controller HUMAN_WALLET --circle-wallet CIRCLE_WALLET [--home DIRECTORY] [--treasury human|circle] [--budget USDC]',
        'argus-agent doctor [--config FILE]', 'argus-agent enable-execution [--config FILE]', 'argus-agent disable-execution [--config FILE]',
        'argus-agent mcp', 'argus-agent tools', 'argus-agent OPERATION --json JSON_OBJECT'],
      configuration: 'ARGUS_AGENT_CONFIG selects a workspace; default is ~/.argus-agent/config.json. MCP uses standard stdio.',
      scope: 'Arc mainnet, real USDC. Setup defaults to read-only; no terms acceptance or wallet creation is automatic. Setup --budget sets the cumulative USDC budget: default 10, at most 100.' };
    else if (command === 'setup') result = setupWorkspace(parseFlags(args, setupOptions));
    else if (command === 'circle-setup') result = await installCircle(parseFlags(args, ['--home']));
    else if (command === 'circle') {
      const flags = args[0] === '--home' ? parseFlags(args.slice(0, 2), ['--home']) : {};
      return await runCircle(args.slice(flags['--home'] ? 2 : 0), { home: flags['--home'] });
    }
    else if (['doctor', 'enable-execution', 'disable-execution'].includes(command)) {
      const flags = parseFlags(args, ['--config']);
      const path = flags['--config'] ? resolve(flags['--config']) : defaultConfig();
      result = command === 'doctor' ? await doctor(path) : await setExecution(path, command === 'enable-execution');
    } else if (command === 'mcp') {
      if (args.length) throw Object.assign(new Error('MCP accepts configuration through ARGUS_AGENT_CONFIG.'), { code: 'ARGUS_INVALID_INPUT', safe: true });
      const { loadConfiguredAgent } = await import('./cli.mjs');
      const { createArgusMcpServer } = await import('./mcp.mjs');
      const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
      const agent = await loadConfiguredAgent(defaultConfig());
      const handle = serveStdio(() => createArgusMcpServer(agent), { transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128 * 1024 }) });
      let closed = false;
      const close = async () => { if (closed) return; closed = true; await handle.close(); await agent.close(); };
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close(); });
      process.stdin.once('end', () => { void close(); });
      return 0;
    } else return runCli(argv, { write, configPath: defaultConfig() });
  } catch (error) {
    result = { error: { code: error.safe ? error.code : 'ARGUS_SETUP_FAILED', message: error.safe ? error.message : 'The operation could not finish. Check the selected workspace and run doctor; existing records were not reset.' } };
  }
  write(`${json(result)}\n`);
  return result.error || result.status === 'needs_setup' ? 1 : 0;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await runEntry(process.argv.slice(2));
