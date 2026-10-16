import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { BetaServiceError, MAX_ASSET_BYTES, MAX_JSON_BYTES, readBoundedJson, validateProjectReference } from "./beta-service-client.mjs";

const fail = (code, message, status = 400) => { throw new BetaServiceError(code, message, status); };
const digest = value => createHash("sha256").update(value).digest();
const PINATA_UPLOAD = "https://uploads.pinata.cloud/v3/files";
export const BETA_LIMITS = Object.freeze({ requestsPerMinute: 120, projectsPerUser: 100, uploadsPerDay: 20, assetsPerUser: 200, uploadsInFlight: 4 });
function invitations(input) {
  let value;
  try { value = typeof input === "string" ? JSON.parse(input) : input; } catch { fail("INVITES_INVALID", "ARGUS_BETA_TOKENS must be a JSON object mapping access tokens to user IDs."); }
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length < 1 || Object.keys(value).length > 100) fail("INVITES_INVALID", "Configure between 1 and 100 access tokens.");
  return Object.entries(value).map(([token, user]) => {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token) || typeof user !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(user)) fail("INVITES_INVALID", "Each access token must be random and map to a stable user ID.");
    return { hash: digest(token), user };
  });
}
function imageInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["base64", "filename", "contentType"].includes(key))) fail("INVALID_ASSET", "Provide image bytes, filename and contentType only.");
  if (typeof value.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.filename) || !["image/png", "image/jpeg", "image/webp"].includes(value.contentType)) fail("INVALID_ASSET", "Provide a plain filename and PNG, JPEG or WebP content type.");
  if (typeof value.base64 !== "string" || !value.base64.length || value.base64.length % 4 !== 0 || value.base64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)) fail("INVALID_ASSET", "Provide a base64 image of at most 2 MiB.");
  const bytes = Buffer.from(value.base64, "base64");
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES || bytes.toString("base64") !== value.base64) fail("INVALID_ASSET", "Invalid image byte encoding.");
  let type;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && bytes.toString("ascii", 12, 16) === "IHDR") type = "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) type = "image/jpeg";
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) type = "image/webp";
  if (type !== value.contentType) fail("INVALID_ASSET", "Image magic bytes do not match the declared PNG, JPEG or WebP type.");
  return { bytes, contentType: type, filename: value.filename, hash: digest(bytes).toString("hex") };
}

/** Single-host shared service. Records are bookmarks, never wallet or on-chain authority. */
export function createBetaService({ dbPath, inviteTokens = process.env.ARGUS_BETA_TOKENS, pinataJwt = process.env.PINATA_JWT, fetchImpl = fetch, limits: overrides = {}, now = Date.now } = {}) {
  const invites = invitations(inviteTokens);
  const limits = { ...BETA_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) if (!Object.hasOwn(BETA_LIMITS, key) || !Number.isInteger(value) || value < 1 || value > BETA_LIMITS[key]) fail("LIMIT_INVALID", "Service limit overrides must be positive and no greater than the default.");
  if (typeof dbPath !== "string" || !dbPath) fail("DATABASE_REQUIRED", "Provide the private service database path.");
  const filename = resolve(dbPath);
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename); chmodSync(filename, 0o600);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS bookmarks (owner TEXT NOT NULL, token TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (owner,token));
    CREATE TABLE IF NOT EXISTS assets (owner TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, json TEXT, PRIMARY KEY (owner,hash));
    CREATE TABLE IF NOT EXISTS quotas (owner TEXT NOT NULL, kind TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (owner,kind,window));`);
  let activeUploads = 0;
  function transaction(fn) { db.exec("BEGIN IMMEDIATE"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } }
  function quota(owner, kind, duration, maximum) {
    const window = Math.floor(now() / duration);
    db.prepare("DELETE FROM quotas WHERE kind=? AND window<?").run(kind, window - 1);
    const count = db.prepare("SELECT count FROM quotas WHERE owner=? AND kind=? AND window=?").get(owner, kind, window)?.count ?? 0;
    if (count >= maximum) fail("QUOTA_EXCEEDED", "The service quota has been reached.", 429);
    db.prepare("INSERT INTO quotas VALUES (?,?,?,1) ON CONFLICT(owner,kind,window) DO UPDATE SET count=count+1").run(owner, kind, window);
  }
  function authenticate(request) {
    const header = request.headers.authorization;
    const token = typeof header === "string" && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(header) ? header.slice(7) : "";
    const hash = digest(token); let owner;
    for (const invite of invites) if (timingSafeEqual(hash, invite.hash)) owner = invite.user;
    if (!owner) fail("UNAUTHORIZED", "A valid access token is required.", 401);
    transaction(() => quota(owner, "requests", 60_000, limits.requestsPerMinute));
    return owner;
  }
  function send(response, status, result) {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(JSON.stringify(result));
  }
  async function body(request, maximum) {
    if (request.headers["content-type"]?.split(";")[0] !== "application/json" || request.headers["content-encoding"]) fail("CONTENT_TYPE", "Use uncompressed application/json.", 415);
    if (Number(request.headers["content-length"] ?? 0) > maximum) fail("BODY_TOO_LARGE", "The request exceeds its size limit.", 413);
    return readBoundedJson(request, maximum);
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5000 }, async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") { send(response, 200, { ok: true }); return; }
      const owner = authenticate(request);
      if (request.method === "GET" && request.url === "/v1/projects") {
        const projects = db.prepare("SELECT json FROM bookmarks WHERE owner=? ORDER BY token LIMIT ?").all(owner, limits.projectsPerUser).map(row => JSON.parse(row.json));
        send(response, 200, { projects, authority: "bookmarks_only" }); return;
      }
      const route = /^\/v1\/projects\/5042\/(0x[\da-f]{40})$/i.exec(request.url ?? "");
      if (request.method === "PUT" && route) {
        const project = validateProjectReference(await body(request, 4096));
        if (project.token !== route[1].toLowerCase()) fail("INVALID_PROJECT", "The route and project token must match.");
        transaction(() => {
          const existing = db.prepare("SELECT json FROM bookmarks WHERE owner=? AND token=?").get(owner, project.token);
          if (!existing && db.prepare("SELECT count(*) AS total FROM bookmarks WHERE owner=?").get(owner).total >= limits.projectsPerUser) fail("QUOTA_EXCEEDED", "The project bookmark limit has been reached.", 429);
          db.prepare("INSERT INTO bookmarks VALUES (?,?,?) ON CONFLICT(owner,token) DO UPDATE SET json=excluded.json").run(owner, project.token, JSON.stringify(project));
        });
        send(response, 200, { project, authority: "bookmarks_only" }); return;
      }
      if (request.method === "POST" && request.url === "/v1/assets") {
        const asset = imageInput(await body(request, MAX_JSON_BYTES));
        const prior = db.prepare("SELECT state,json FROM assets WHERE owner=? AND hash=?").get(owner, asset.hash);
        if (prior?.state === "confirmed") { send(response, 200, JSON.parse(prior.json)); return; }
        if (prior) fail("UPLOAD_UNRESOLVED", "An earlier upload is unresolved; ask the Argus team to reconcile it before retrying.", 409);
        if (!pinataJwt) fail("UPLOAD_NOT_CONFIGURED", "Asset hosting is not configured on this service.", 503);
        if (activeUploads >= limits.uploadsInFlight) fail("UPLOAD_BUSY", "The asset service is busy.", 429);
        transaction(() => {
          if (db.prepare("SELECT count(*) AS total FROM assets WHERE owner=?").get(owner).total >= limits.assetsPerUser) fail("QUOTA_EXCEEDED", "The total asset limit has been reached.", 429);
          quota(owner, "uploads", 86_400_000, limits.uploadsPerDay);
          db.prepare("INSERT INTO assets VALUES (?,?,'pending',NULL)").run(owner, asset.hash);
        });
        activeUploads++;
        try {
          // Pinata's documented V3 public upload API. Never accept an upload URL from a client.
          // https://docs.pinata.cloud/api-reference/endpoint/upload-a-file
          const form = new FormData(); form.append("network", "public");
          form.append("file", new Blob([asset.bytes], { type: asset.contentType }), asset.filename);
          const upstream = await fetchImpl(PINATA_UPLOAD, { method: "POST", headers: { Authorization: `Bearer ${pinataJwt}` }, body: form, redirect: "error", signal: AbortSignal.timeout(30_000) });
          if (!upstream.ok) fail("PINATA_FAILED", "Asset upload did not return success.", 502);
          const result = await readBoundedJson(upstream.body, 16 * 1024);
          const cid = result?.data?.cid;
          if (typeof cid !== "string" || !/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(cid)) fail("PINATA_FAILED", "Asset upload returned an invalid CID.", 502);
          const record = { uri: `ipfs://${cid}`, cid, sha256: asset.hash, contentType: asset.contentType, size: asset.bytes.length };
          db.prepare("UPDATE assets SET state='confirmed',json=? WHERE owner=? AND hash=?").run(JSON.stringify(record), owner, asset.hash);
          send(response, 201, record);
        } catch {
          // Pinata may already have pinned the bytes. Retain the reservation instead of uploading again automatically.
          db.prepare("UPDATE assets SET state='unknown' WHERE owner=? AND hash=?").run(owner, asset.hash);
          fail("UPLOAD_UNRESOLVED", "The upload outcome is unresolved; the Argus team must reconcile it.", 502);
        } finally { activeUploads--; }
        return;
      }
      fail("NOT_FOUND", "Unknown service route.", 404);
    } catch (error) {
      const known = error instanceof BetaServiceError;
      if (!response.headersSent) send(response, known ? error.status : 500, { error: { code: known ? error.code : "INTERNAL_ERROR", message: known ? error.message : "The service could not complete the request." } });
    }
  });
  server.maxConnections = 64;
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  return { server, async close() { if (server.listening) { server.closeIdleConnections(); await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); } db.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [, , dbPath, portInput = "3199"] = process.argv;
    const port = Number(portInput);
    if (!dbPath || !Number.isInteger(port) || port < 1 || port > 65535) fail("USAGE", "Usage: node beta-service.mjs <private-database-path> [port]");
    const service = createBetaService({ dbPath });
    service.server.listen(port, "127.0.0.1", () => process.stdout.write(`Argus shared service listening on 127.0.0.1:${port}. Remote access requires a TLS reverse proxy.\n`));
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
  } catch (error) { process.stderr.write(`${error instanceof BetaServiceError ? error.code : "START_FAILED"}: Could not start the shared service.\n`); process.exitCode = 1; }
}
