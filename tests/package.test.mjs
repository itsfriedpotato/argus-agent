import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runEntry } from '../scripts/argus-agent/entry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const text = async path => (await readFile(join(ROOT, path), 'utf8')).replace(/\r\n/g, '\n');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function listFiles(directory) {
  const base = join(ROOT, directory);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile())
    .map(entry => posix.join(directory, relative(base, join(entry.parentPath, entry.name)).split(sep).join('/')))
    .sort();
}

function moduleSpecifiers(source) {
  return [
    ...source.matchAll(/^\s*(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map(match => match[1]);
}

test('package.json, CLI help, MCP serverInfo and the changelog name one release', async () => {
  assert.equal(metadata.name, '@argus-world/agent');
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  let output = '';
  await runEntry(['--help'], { write: value => { output += value; } });
  const help = JSON.parse(output);
  assert.equal(help.version, metadata.version, 'CLI help names the package version');
  assert.match(help.scope, /at most 100/);
  assert.ok((await text('scripts/argus-agent/mcp.mjs')).includes(`{ name: 'argus-agent', version: '${metadata.version}' }`), 'MCP serverInfo names the package version');
  assert.match(await text('CHANGELOG.md'), new RegExp(`^# Changelog\\n\\n## ${escape(metadata.version)} - \\d{4}-\\d{2}-\\d{2}\\n`));
  for (const path of ['README.md', 'SECURITY.md', 'docs/install.md', 'docs/guide.md']) {
    const pinned = [...(await text(path)).matchAll(/@argus-world\/agent@([0-9][^\s`'"]*)/g)].map(match => match[1]);
    assert.ok(pinned.every(version => version === metadata.version), `${path} pins ${pinned.join(', ')}`);
  }
  assert.ok((await text('docs/install.md')).includes(`shows the version, \`${metadata.version}\``));
});

test('the package is MIT licensed, publishable with provenance and installs without lifecycle scripts', async () => {
  assert.equal(metadata.license, 'MIT');
  assert.equal(metadata.private, undefined);
  assert.deepEqual(metadata.publishConfig, { access: 'public', provenance: true });
  assert.equal(metadata.repository.url, 'git+https://github.com/itsfriedpotato/argus-agent.git', 'npm provenance requires the exact repository URL');
  assert.match(await text('LICENSE'), /^MIT License\n\nCopyright \(c\) 2026 Argus\n\nPermission is hereby granted, free of charge/);
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly']) {
    assert.equal(metadata.scripts?.[name], undefined, `Installing or packing must not run the ${name} script`);
  }
  assert.equal(metadata.engines.node, '>=22.13.0');
  assert.deepEqual(metadata.os, ['darwin', 'linux', 'win32']);
  assert.equal(metadata.bin['argus-agent'], 'scripts/argus-agent/entry.mjs');
  assert.ok((await text(metadata.bin['argus-agent'])).startsWith('#!/usr/bin/env node\n'));
});

test('the generated contract helpers match their manifest and need no TypeScript at runtime', async () => {
  const manifest = JSON.parse(await text('scripts/argus-agent/generated/manifest.json'));
  const generated = (await listFiles('scripts/argus-agent/generated')).map(path => posix.basename(path)).filter(name => name !== 'manifest.json');
  assert.deepEqual(generated, Object.keys(manifest.files).sort());
  for (const [name, record] of Object.entries(manifest.files)) {
    const source = await text(`scripts/argus-agent/generated/${name}`);
    assert.equal(sha256(source), record.sha256, `${name} differs from its manifest; regenerate it from the Argus app`);
    assert.doesNotMatch(source, /loadTs|tests\/helpers|from ["']typescript["']/);
  }
});

test('the files allowlist covers the whole runtime and every runtime import resolves inside it', async () => {
  const files = new Set(metadata.files);
  assert.equal(files.size, metadata.files.length, 'package.json files has duplicates');
  for (const path of [...await listFiles('scripts/argus-agent'), ...await listFiles('skills')]) {
    assert.ok(files.has(path), `${path} must be listed in package.json files`);
  }
  for (const path of files) assert.ok((await readFile(join(ROOT, path))).length > 0, path);
  for (const path of metadata.files.filter(file => file.endsWith('.mjs'))) {
    const source = await text(path);
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        assert.ok(files.has(target), `${path} imports ${target}, which the package omits`);
      } else {
        const dependency = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        assert.ok(Object.hasOwn(metadata.dependencies, dependency), `${path} imports undeclared dependency ${dependency}`);
      }
    }
    for (const [, relative] of source.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]*)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
      if (relative.endsWith('/')) continue; // A development cache directory, never a packaged file.
      const target = posix.normalize(posix.join(posix.dirname(path), relative));
      assert.ok(files.has(target), `${path} reads ${target}, which the package omits`);
    }
  }
});

test('published text carries no private-release wording or references into another repository', async () => {
  for (const path of [...metadata.files, 'README.md', 'SECURITY.md', 'CHANGELOG.md']) {
    const source = await text(path);
    assert.doesNotMatch(source, /private beta|invited testers?|do not redistribute|coworker|pilot operator|all rights reserved|UNLICENSED/i, path);
    // The Argus contracts are audited (owner, 2026-10-16): no file may say otherwise.
    assert.doesNotMatch(source, /unaudited|not been audited|afford to lose/i, path);
    assert.doesNotMatch(source, /\.\.\/\.\.\/public\/|mcp-ownership|helpers\/load-ts|build-package\.mjs|compile-contracts\.mjs/, path);
  }
});
