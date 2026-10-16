import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = message => { throw Object.assign(new Error(message), { code: 'ARGUS_PRIVATE_FILE', safe: true }); };

export function assertPrivateConfigFile(path, { maxBytes = 65536 } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('Use an absolute path to a private configuration file.');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail('Configuration must be a regular bounded file, not a symbolic link.');
  // Windows protects the per-user directory through ACLs; POSIX mode bits do not describe those ACLs.
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fail('Configuration must be readable only by its owner (chmod 600).');
  return stat;
}

export function readPrivateJson(path, options) {
  assertPrivateConfigFile(path, options);
  const result = JSON.parse(readFileSync(path, 'utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('Configuration must contain a JSON object.');
  return result;
}

export function writePrivateJson(path, value, { exclusive = false } = {}) {
  if (!isAbsolute(path)) fail('Use an absolute configuration path.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) return writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
