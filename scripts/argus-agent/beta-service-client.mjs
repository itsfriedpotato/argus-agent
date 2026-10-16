import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_BYTES = Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 1024;
export class BetaServiceError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = "BetaServiceError"; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new BetaServiceError(code, message, status); };
const fields = ["chainId", "token", "launchTxHash", "launchBlock", "controller", "operator", "treasury"];
export function validateProjectReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) fail("INVALID_PROJECT", "Provide only the required project reference fields.");
  if (value.chainId !== 5042 || !/^0x[\da-f]{64}$/i.test(value.launchTxHash) || typeof value.launchBlock !== "string" || !/^[1-9]\d{0,19}$/.test(value.launchBlock)) fail("INVALID_PROJECT", "A project requires Arc mainnet and a launch transaction and block.");
  for (const key of ["token", "controller", "operator", "treasury"]) {
    if (key === "treasury" && value[key] === null) continue; // Launch events do not always establish allocation custody.
    if (typeof value[key] !== "string" || !/^0x[\da-f]{40}$/i.test(value[key]) || /^0x0{40}$/i.test(value[key])) fail("INVALID_PROJECT", "Project addresses must be nonzero EVM addresses; an unverified treasury must be null.");
  }
  return Object.fromEntries(fields.map(key => [key, typeof value[key] === "string" ? value[key].toLowerCase() : value[key]]));
}
export async function readBoundedJson(body, maximum = 512 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maximum) fail("BODY_TOO_LARGE", "The response or request exceeds its size limit.", 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("INVALID_JSON", "The response or request is not valid JSON."); }
}
function credential(filename) {
  if (typeof filename !== "string" || !isAbsolute(filename)) fail("BETA_AUTH_FILE", "Configure an absolute path to an owner-only access token file.");
  let fd;
  try {
    if (lstatSync(filename).isSymbolicLink()) fail("BETA_AUTH_FILE", "The access token file must not be a symbolic link.");
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0) || (process.getuid && stat.uid !== process.getuid()) || stat.size > 1024) fail("BETA_AUTH_FILE", "The access token file must be a small file owned by this user, with permissions 0600 on POSIX or a private user ACL on Windows.");
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) fail("BETA_AUTH_FILE", "The access token file does not contain a valid access token.");
    return token;
  } catch (error) {
    if (error instanceof BetaServiceError) throw error;
    fail("BETA_AUTH_FILE", "Could not read the owner-only access token file.");
  } finally { if (fd !== undefined) closeSync(fd); }
}
function endpoint(config) {
  let url;
  try { url = new URL(config?.url); } catch { fail("BETA_URL", "Configure the shared service HTTPS origin."); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("BETA_URL", "The service requires an HTTPS origin; HTTP is allowed only on loopback.");
  return url.origin;
}
export function createBetaServiceClient(config, { fetchImpl = fetch, readToken = credential } = {}) {
  const origin = endpoint(config);
  async function request(path, method = "GET", value) {
    const body = value === undefined ? undefined : JSON.stringify(value);
    if (body && Buffer.byteLength(body) > MAX_JSON_BYTES) fail("BODY_TOO_LARGE", "The upload exceeds the 2 MiB image limit.", 413);
    let response;
    try { response = await fetchImpl(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${readToken(config.tokenFile)}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body, redirect: "error", signal: AbortSignal.timeout(45_000) }); }
    catch (error) { if (error instanceof BetaServiceError) throw error; fail("BETA_UNAVAILABLE", "The shared service request did not complete. Check the service before repeating an upload.", 502); }
    const result = await readBoundedJson(response.body);
    if (!response.ok) {
      const code = typeof result?.error?.code === "string" && /^[A-Z_]{1,64}$/.test(result.error.code) ? result.error.code : "BETA_REQUEST_FAILED";
      // Never echo server-controlled messages: a proxy response may contain credentials.
      fail(code, `The shared service rejected the request (HTTP ${response.status}).`, response.status);
    }
    return result;
  }
  return {
    async listProjects() {
      const result = await request("/v1/projects");
      if (result.authority !== "bookmarks_only" || !Array.isArray(result.projects) || result.projects.length > 100) fail("BETA_RESPONSE_INVALID", "Invalid project bookmark response.", 502);
      return { authority: "bookmarks_only", projects: result.projects.map(validateProjectReference) };
    },
    async saveProject(reference) {
      const project = validateProjectReference(reference);
      const result = await request(`/v1/projects/${project.chainId}/${project.token}`, "PUT", project);
      if (result.authority !== "bookmarks_only") fail("BETA_RESPONSE_INVALID", "Invalid project bookmark response.", 502);
      return { authority: "bookmarks_only", project: validateProjectReference(result.project) };
    },
    async uploadAsset(asset) {
      const result = await request("/v1/assets", "POST", asset);
      if (typeof result.cid !== "string" || !/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(result.cid) || result.uri !== `ipfs://${result.cid}` || !/^[\da-f]{64}$/.test(result.sha256) || !["image/png", "image/jpeg", "image/webp"].includes(result.contentType) || !Number.isInteger(result.size) || result.size < 1 || result.size > MAX_ASSET_BYTES) fail("BETA_RESPONSE_INVALID", "Invalid pinned asset response.", 502);
      const bytes = Buffer.from(asset.base64, "base64");
      if (result.sha256 !== createHash("sha256").update(bytes).digest("hex") || result.size !== bytes.length || result.contentType !== asset.contentType) fail("BETA_RESPONSE_INVALID", "The pinned asset response does not match the uploaded bytes.", 502);
      return { uri: result.uri, cid: result.cid, sha256: result.sha256, contentType: result.contentType, size: result.size };
    },
  };
}
export const listProjects = (config, deps) => createBetaServiceClient(config, deps).listProjects();
export const saveProject = (config, reference, deps) => createBetaServiceClient(config, deps).saveProject(reference);
export const uploadAsset = (config, asset, deps) => createBetaServiceClient(config, deps).uploadAsset(asset);
