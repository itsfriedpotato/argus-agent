import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMvpAgent } from '../scripts/argus-agent/mvp.mjs';

const token = `0x${'12'.repeat(20)}`;
const hash = `0x${'34'.repeat(32)}`;
const project = { chainId: 5042, token, launchTxHash: hash, launchBlock: '123', controller: token, operator: token, treasury: null };
function base(dispatch) { return { catalog: [], dispatch, close() {} }; }

test('restoring remote bookmarks invokes canonical import, never action execution', async () => {
  const calls = [];
  const agent = await createMvpAgent({}, { baseAgent: base(async (name, args) => { calls.push({ name, args }); return { project }; }),
    service: { listProjects: async () => ({ projects: [project] }) } });
  const result = await agent.dispatch('argus_sync_projects', { direction: 'pull' });
  assert.equal(result.status, 'synced');
  assert.deepEqual(calls, [{ name: 'argus_import_project', args: { launchTxHash: hash, token } }]);
});

test('confirmed launch with failed bookmark backup remains confirmed and is not repeated', async () => {
  const action = { id: 'id', status: 'confirmed', kind: 'launch' };
  const calls = [];
  const agent = await createMvpAgent({}, { baseAgent: base(async name => { calls.push(name); return name === 'argus_list_projects' ? { projects: [project] } : { action }; }),
    service: { saveProject: async () => { throw new Error('secret service details'); } } });
  const result = await agent.dispatch('argus_execute_action', { actionId: 'id' });
  assert.equal(result.action.status, 'confirmed');
  assert.equal(result.projectBackup.status, 'pending');
  assert(!JSON.stringify(result).includes('secret service'));
  assert.deepEqual(calls, ['argus_execute_action', 'argus_list_projects']);
});

test('an invalid remote project fails independently without pretending complete restoration', async () => {
  const agent = await createMvpAgent({}, { baseAgent: base(async () => ({ error: { code: 'ARGUS_PROJECT_UNVERIFIED' } })),
    service: { listProjects: async () => ({ projects: [project] }) } });
  const result = await agent.dispatch('argus_sync_projects', { direction: 'pull' });
  assert.equal(result.status, 'partial');
  assert.equal(result.outcomes[0].status, 'failed');
});

test('a launch confirmed by get_action after interruption backs up only its matching project', async () => {
  const saved = [];
  const action = { id: 'reconciled-launch', status: 'confirmed', kind: 'launch', steps: [{ hash }] };
  const agent = await createMvpAgent({}, { baseAgent: base(async name => name === 'argus_list_projects'
    ? { projects: [project, { ...project, token: `0x${'56'.repeat(20)}`, launchTxHash: `0x${'78'.repeat(32)}` }] } : { action }),
  service: { saveProject: async value => { saved.push(value); } } });
  const result = await agent.dispatch('argus_get_action', { actionId: action.id });
  assert.equal(result.projectBackup.status, 'saved');
  assert.deepEqual(saved, [project]);
});

test('upload uses explicit bounded local bytes and verifies returned content identity', async t => {
  const root = mkdtempSync(join(tmpdir(), 'argus-asset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('a supplied fixture image');
  const path = join(root, 'supplied image.png');
  writeFileSync(path, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const agent = await createMvpAgent({}, { baseAgent: base(async () => ({})), service: { uploadAsset: async asset => {
    assert.equal(asset.base64, bytes.toString('base64')); return { sha256, uri: 'ipfs://test' };
  } } });
  assert.equal((await agent.dispatch('argus_upload_asset', { path, contentType: 'image/png' })).asset.sha256, sha256);
  assert.equal((await agent.dispatch('argus_upload_asset', { path: 'relative.png', contentType: 'image/png' })).error.code, 'ARGUS_ASSET_PATH');
  const mismatch = await createMvpAgent({}, { baseAgent: base(async () => ({})), service: { uploadAsset: async () => ({ sha256: 'wrong' }) } });
  assert.equal((await mismatch.dispatch('argus_upload_asset', { path, contentType: 'image/png' })).error.code, 'ARGUS_ASSET_MISMATCH');
});

test('service tools are absent when unconfigured and fail clearly if invoked', async () => {
  const agent = await createMvpAgent({}, { baseAgent: base(async () => ({})) });
  assert.equal(agent.catalog.length, 0);
  assert.equal((await agent.dispatch('argus_sync_projects')).error.code, 'ARGUS_SERVICE_NOT_CONFIGURED');
});
