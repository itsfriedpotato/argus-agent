import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createArgusAgent } from './sdk.mjs';
import { readPrivateJson } from './private-files.mjs';
import { BetaServiceError, createBetaServiceClient, MAX_ASSET_BYTES } from './beta-service-client.mjs';

const schemas = {
  argus_upload_asset: z.strictObject({ path: z.string().min(1).max(4096), contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']) }),
  argus_sync_projects: z.strictObject({ direction: z.enum(['pull', 'push', 'both']).default('both') }),
};
const descriptions = {
  argus_upload_asset: 'Pin a supplied local PNG, JPEG or WebP image through the authenticated Argus shared service. Returns an IPFS URI for launch branding. Maximum 2 MiB. Never upload credentials or unrelated files.',
  argus_sync_projects: 'Recover confirmed project bookmarks from the shared service, rechecking each launch on-chain, and/or save this workspace’s project references. Does not recover pending transactions or grant wallet authority. No signing or transaction submission.',
};
const extensionCatalog = Object.entries(schemas).map(([name, schema]) => ({ name, description: descriptions[name],
  inputSchema: z.toJSONSchema(schema, { io: 'input' }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }));
const safeError = error => ({ error: { code: error instanceof BetaServiceError || error.safe ? error.code : 'ARGUS_SERVICE_FAILED',
  message: error instanceof BetaServiceError || error.safe ? error.message : 'The service operation did not finish. Confirm its outcome before repeating an upload.', retryable: false } });
const fail = (code, message) => { throw Object.assign(new Error(message), { code, safe: true }); };
function reference(project) {
  return { chainId: 5042, token: project.token, launchTxHash: project.launchTxHash,
    launchBlock: String(project.launchBlock), controller: project.controller, operator: project.operator, treasury: project.treasury ?? null };
}
function readImage(path, contentType) {
  if (!isAbsolute(path)) fail('ARGUS_ASSET_PATH', 'Supply the absolute path of the image to upload.');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ASSET_BYTES) fail('ARGUS_ASSET_SIZE', 'Supply a regular image file no larger than 2 MiB.');
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) fail('ARGUS_ASSET_CHANGED', 'The image changed while being read.');
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[contentType];
    const cleanName = basename(path).replace(/[^A-Za-z0-9._-]/g, '_');
    const filename = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(cleanName) ? cleanName : `asset.${extension}`;
    return { asset: { base64: bytes.toString('base64'), filename, contentType }, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) { if (error.safe) throw error; fail('ARGUS_ASSET_UNREADABLE', 'The supplied local image could not be read.'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Thin hosted-asset/bookmark adapter; all chain operations stay in the shared SDK. */
export async function createMvpAgent(config, { baseAgent, service } = {}) {
  const agent = baseAgent || await createArgusAgent(config);
  let remote;
  try { remote = service || (config.betaService ? createBetaServiceClient(config.betaService) : null); }
  catch (error) { agent.close(); throw error; }
  async function sync(direction) {
    const outcomes = [];
    if (direction !== 'push') {
      const saved = await remote.listProjects();
      for (const item of saved.projects) {
        const imported = await agent.dispatch('argus_import_project', { launchTxHash: item.launchTxHash, token: item.token });
        outcomes.push({ token: item.token, direction: 'pull', status: imported.error ? 'failed' : 'verified', ...(imported.error ? { error: imported.error } : {}) });
      }
    }
    if (direction !== 'pull') {
      const listed = await agent.dispatch('argus_list_projects');
      if (listed.error) return listed;
      for (const item of listed.projects) {
        try { await remote.saveProject(reference(item)); outcomes.push({ token: item.token, direction: 'push', status: 'saved' }); }
        catch (error) { outcomes.push({ token: item.token, direction: 'push', status: 'failed', ...safeError(error) }); }
      }
    }
    return { status: outcomes.some(item => item.status === 'failed') ? 'partial' : 'synced', outcomes,
      scope: 'Confirmed project references only. Current authority was verified on-chain when imported. Pending actions and wallet credentials are not synchronized.' };
  }
  return { ...agent, catalog: [...agent.catalog, ...(remote ? extensionCatalog : [])], async dispatch(name, args = {}) {
    if (Object.hasOwn(schemas, name)) {
      if (!remote) return { error: { code: 'ARGUS_SERVICE_NOT_CONFIGURED', message: 'Configure the shared service URL and access token file for images and cross-device bookmarks.', retryable: false } };
      try {
        const parsed = schemas[name].safeParse(args);
        if (!parsed.success) fail('ARGUS_INVALID_ARGUMENTS', 'Arguments do not match this operation. Read its tool schema.');
        if (name === 'argus_sync_projects') return await sync(parsed.data.direction);
        const { asset, sha256 } = readImage(parsed.data.path, parsed.data.contentType);
        const result = await remote.uploadAsset(asset);
        if (result.sha256 !== sha256) fail('ARGUS_ASSET_MISMATCH', 'The hosted image digest does not match the supplied bytes.');
        return { asset: result };
      } catch (error) { return safeError(error); }
    }
    const result = await agent.dispatch(name, args);
    if (remote && !result.error && (name === 'argus_import_project' ||
      (['argus_execute_action', 'argus_get_action', 'argus_reconcile_transaction'].includes(name) && result.action?.kind === 'launch' && result.action.status === 'confirmed'))) {
      try {
        const projects = result.project ? [result.project] : (await agent.dispatch('argus_list_projects')).projects.filter(project =>
          project.launchActionId === result.action.id || project.launchTxHash?.toLowerCase() === result.action.steps?.at(-1)?.hash?.toLowerCase());
        if (!projects.length) throw new Error('The confirmed launch project reference is unavailable.');
        for (const project of projects) await remote.saveProject(reference(project));
        return { ...result, projectBackup: { status: 'saved', scope: 'Project references only; wallet credentials and pending actions remain local.' } };
      } catch { return { ...result, projectBackup: { status: 'pending', message: 'The chain operation succeeded but its hosted bookmark was not saved. Keep the launch receipt and retry argus_sync_projects; do not repeat the launch.' } }; }
    }
    return result;
  } };
}

export async function createMvpAgentFromConfig(path) { return createMvpAgent(readPrivateJson(path)); }
