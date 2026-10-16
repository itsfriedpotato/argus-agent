import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBetaService } from "../scripts/argus-agent/beta-service.mjs";
import { createBetaServiceClient, readBoundedJson } from "../scripts/argus-agent/beta-service-client.mjs";

const ALICE = "alice_".repeat(8), BOB = "bob_".repeat(12), PINATA = "test-upstream-credential";
const CID = "bafybeigns2cxq5rbl6ezkdufirrknyhsmidn452oapimgt2s67einshffe";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
const image = { filename: "test.png", contentType: "image/png", base64: PNG };
const address = n => `0x${String(n).repeat(40)}`;
const project = (extra = {}) => ({ chainId: 5042, token: address(1), launchTxHash: `0x${"a".repeat(64)}`, launchBlock: "12345", controller: address(2), operator: address(3), treasury: address(2), ...extra });
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "argus-beta-service-"));
  const dbPath = join(directory, "service.sqlite");
  const calls = []; let current;
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    return new Response(JSON.stringify({ data: { cid: CID } }), { headers: { "Content-Type": "application/json" } });
  };
  async function start() {
    current = createBetaService({ dbPath, inviteTokens: { [ALICE]: "alice", [BOB]: "bob" }, pinataJwt: PINATA, fetchImpl, ...options });
    await new Promise(resolve => current.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${current.server.address().port}`;
  }
  let url = await start();
  const tokenFile = join(directory, "invite"); writeFileSync(tokenFile, ALICE, { mode: 0o600 });
  t.after(async () => { await current.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, dbPath, tokenFile, calls, get url() { return url; },
    client: token => createBetaServiceClient({ url, tokenFile }, token ? { readToken: () => token } : {}),
    request: (path, options = {}) => fetch(`${url}${path}`, { ...options, headers: { Authorization: `Bearer ${ALICE}`, "Content-Type": "application/json", ...options.headers } }),
    async restart() { await current.close(); url = await start(); },
  };
}

test("invite-only bookmarks survive restart, remain per-user and never grant authority", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client().saveProject(project()), { project: project(), authority: "bookmarks_only" });
  assert.deepEqual(await f.client(BOB).listProjects(), { projects: [], authority: "bookmarks_only" });
  await f.restart();
  assert.deepEqual(await f.client().listProjects(), { projects: [project()], authority: "bookmarks_only" });
  assert.equal(readFileSync(f.dbPath).includes(Buffer.from(ALICE)), false);
  assert.equal(readFileSync(f.dbPath).includes(Buffer.from(PINATA)), false);
  await f.client().saveProject(project({ treasury: null }));
  assert.equal((await f.client().listProjects()).projects[0].treasury, null);
});

test("health exposes no project or account information and all other routes require an invite", async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await fetch(`${f.url}/health`)).json(), { ok: true });
  for (const path of ["/v1/projects", "/v1/assets", `/v1/projects/5042/${address(1)}`]) {
    const result = await fetch(`${f.url}${path}`);
    assert.equal(result.status, 401);
    assert.equal(JSON.stringify(await result.json()).includes(ALICE), false);
  }
});

test("project schema rejects credentials, arbitrary URLs, wrong chain and mismatched route", async t => {
  const f = await fixture(t);
  for (const value of [project({ privateKey: "secret" }), project({ chainId: 1 }), project({ token: address(0) }), project({ launchBlock: 12345 }), project({ controller: "https://internal/" })]) {
    const result = await f.request(`/v1/projects/5042/${address(1)}`, { method: "PUT", body: JSON.stringify(value) });
    assert.equal(result.status, 400);
  }
  const mismatch = await f.request(`/v1/projects/5042/${address(9)}`, { method: "PUT", body: JSON.stringify(project()) });
  assert.equal(mismatch.status, 400);
  assert.deepEqual((await f.client().listProjects()).projects, []);
});

test("project quotas allow an existing bookmark update but no additional projects", async t => {
  const f = await fixture(t, { limits: { projectsPerUser: 1 } });
  await f.client().saveProject(project());
  await f.client().saveProject(project({ controller: address(4) }));
  await assert.rejects(f.client().saveProject(project({ token: address(5) })), { code: "QUOTA_EXCEEDED" });
  assert.equal((await f.client().listProjects()).projects[0].controller, address(4));
});

test("request quota is per user, persisted across restart, and recovers next minute", async t => {
  let clock = 1_000_000;
  const f = await fixture(t, { limits: { requestsPerMinute: 1 }, now: () => clock });
  await f.client().listProjects();
  await f.restart();
  await assert.rejects(f.client().listProjects(), { code: "QUOTA_EXCEEDED" });
  await f.client(BOB).listProjects();
  clock += 60_000;
  await f.client().listProjects();
});

test("public Pinata upload uses a fixed URL, validated bytes, private credentials and durable deduplication", async t => {
  const f = await fixture(t);
  const asset = await f.client().uploadAsset(image);
  assert.deepEqual(asset, { uri: `ipfs://${CID}`, cid: CID, sha256: createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex"), contentType: "image/png", size: Buffer.from(PNG, "base64").length });
  const { url, request } = f.calls[0];
  assert.equal(url, "https://uploads.pinata.cloud/v3/files");
  assert.equal(request.headers.Authorization, `Bearer ${PINATA}`);
  assert.equal(request.redirect, "error");
  assert.equal(request.body.get("network"), "public");
  assert.equal(request.body.get("file").name, "test.png");
  assert.equal(Buffer.from(await request.body.get("file").arrayBuffer()).toString("base64"), PNG);
  await f.restart();
  assert.deepEqual(await f.client().uploadAsset(image), asset);
  assert.equal(f.calls.length, 1);
});

test("uploads reject type spoofing, URL inputs, path filenames and oversized payloads before Pinata", async t => {
  const f = await fixture(t);
  const bad = [
    { ...image, contentType: "image/jpeg" },
    { ...image, filename: "../test.png" },
    { ...image, base64: Buffer.from("<svg>script</svg>").toString("base64") },
    { ...image, url: "http://169.254.169.254/latest/meta-data" },
    { ...image, base64: "not valid base64" },
  ];
  for (const value of bad) await assert.rejects(f.client().uploadAsset(value), { code: "INVALID_ASSET" });
  await assert.rejects(f.client().uploadAsset({ ...image, base64: "A".repeat(3 * 1024 * 1024) }), { code: "BODY_TOO_LARGE" });
  assert.equal(f.calls.length, 0);
});

test("JPEG and WebP magic are accepted, and daily upload quotas survive service restart", async t => {
  const f = await fixture(t, { limits: { uploadsPerDay: 2 } });
  const jpeg = { filename: "test.jpg", contentType: "image/jpeg", base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]).toString("base64") };
  const webp = Buffer.alloc(20); webp.write("RIFF"); webp.writeUInt32LE(12, 4); webp.write("WEBPVP8 ", 8);
  await f.client().uploadAsset(jpeg);
  await f.client().uploadAsset({ filename: "test.webp", contentType: "image/webp", base64: webp.toString("base64") });
  await f.restart();
  await assert.rejects(f.client().uploadAsset(image), { code: "QUOTA_EXCEEDED" });
  assert.equal(f.calls.length, 2);
});

test("uncertain Pinata failures retain a reservation and never automatically upload twice", async t => {
  let attempts = 0;
  const f = await fixture(t, { fetchImpl: async () => { attempts++; throw new Error(`upstream could contain ${PINATA}`); } });
  await assert.rejects(f.client().uploadAsset(image), error => error.code === "UPLOAD_UNRESOLVED" && !error.message.includes(PINATA));
  await f.restart();
  await assert.rejects(f.client().uploadAsset(image), { code: "UPLOAD_UNRESOLVED", status: 409 });
  assert.equal(attempts, 1);
});

test("read-only bookmarks work when asset hosting is not configured", async t => {
  const f = await fixture(t, { pinataJwt: "" });
  await f.client().saveProject(project());
  await assert.rejects(f.client().uploadAsset(image), { code: "UPLOAD_NOT_CONFIGURED" });
  assert.equal(f.calls.length, 0);
});

test("client refuses remote HTTP, embedded credentials and redirectable origin paths", () => {
  for (const url of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=secret", "https://example.com/#fragment"]) assert.throws(() => createBetaServiceClient({ url, tokenFile: "/unused" }), { code: "BETA_URL" });
  for (const url of ["https://example.com", "http://127.0.0.1:3199", "http://[::1]:3199"]) assert.doesNotThrow(() => createBetaServiceClient({ url, tokenFile: "/unused" }));
});

test("client reads an owner-only token file and refuses a symbolic link or broad POSIX permissions", async t => {
  const f = await fixture(t);
  await f.client().listProjects();
  if (process.platform !== "win32") {
    chmodSync(f.tokenFile, 0o644);
    await assert.rejects(f.client().listProjects(), { code: "BETA_AUTH_FILE" });
    chmodSync(f.tokenFile, 0o600);
    const link = join(f.directory, "linked-invite"); symlinkSync(f.tokenFile, link);
    await assert.rejects(createBetaServiceClient({ url: f.url, tokenFile: link }).listProjects(), { code: "BETA_AUTH_FILE" });
  }
});

test("bounded response parsing rejects oversized bodies and unexpected server errors stay private", async () => {
  await assert.rejects(readBoundedJson(new Response("a".repeat(100)).body, 99), { code: "BODY_TOO_LARGE" });
  const client = createBetaServiceClient({ url: "https://beta.example", tokenFile: "/unused" }, { readToken: () => ALICE, fetchImpl: async (_url, request) => {
    assert.equal(request.redirect, "error");
    return new Response(JSON.stringify({ error: { code: "UPSTREAM_FAILED", message: PINATA } }), { status: 502 });
  } });
  await assert.rejects(client.listProjects(), error => error.code === "UPSTREAM_FAILED" && !error.message.includes(PINATA));
});

test("concurrent duplicate images issue one upstream upload and keep other callers unresolved", async t => {
  let finish, started;
  const gate = new Promise(resolve => { finish = resolve; });
  const reached = new Promise(resolve => { started = resolve; });
  let count = 0;
  const f = await fixture(t, { fetchImpl: async () => { count++; started(); await gate; return new Response(JSON.stringify({ data: { cid: CID } })); } });
  const first = f.client().uploadAsset(image);
  await reached;
  try { await assert.rejects(f.client().uploadAsset(image), { code: "UPLOAD_UNRESOLVED", status: 409 }); }
  finally { finish(); }
  await first;
  assert.equal(count, 1);
});

test("client detects successful upload replies for different bytes", async () => {
  const client = createBetaServiceClient({ url: "https://beta.example", tokenFile: "/unused" }, {
    readToken: () => ALICE,
    fetchImpl: async () => new Response(JSON.stringify({ uri: `ipfs://${CID}`, cid: CID, sha256: "0".repeat(64), size: 68, contentType: "image/png" })),
  });
  await assert.rejects(client.uploadAsset(image), { code: "BETA_RESPONSE_INVALID" });
});
