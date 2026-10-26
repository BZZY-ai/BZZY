import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { startRelay } from '@bzzy/relay/server';
import { RelayClient, createIdentity } from '../src/relay/sdk.js';
import { CoreTerminalSharing, ProjectTransferService, libraryShareSelection, importProjectShare, importTerminalShare, importLibraryShare, classifyProjectShareCode } from '../src/relay/project-transfer.js';
import { decodeLibraryCode } from '../src/relay/library-code.js';

const sdk = pathToFileURL(createRequire(import.meta.url).resolve('@bzzy/relay'));
const { RelayStore } = await import(new URL('./store.js', sdk));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read) {
  for (let i = 0; i < 400; i++) { const value = await read(); if (value) return value; await delay(10); }
  assert.fail('Expected Library transfer state was not reached.');
}
async function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-library-transfer-'))), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private'); fs.mkdirSync(process.env.BZZY_HOME, { mode: 0o700 });
  const source = path.join(directory, 'source'), recipient = path.join(directory, 'recipient');
  fs.mkdirSync(source); fs.mkdirSync(recipient);
  const store = new RelayStore(), identity = createIdentity(), audit = [], wire = [], cleanup = [];
  store.provisionHost(identity.certificate);
  const relay = await startRelay({ store, allowInsecureLocal: true, audit: event => audit.push(event) });
  const client = new RelayClient({ url: relay.audience, identity, allowInsecureLocal: true, autoReconnect: false });
  await client.connect();
  const send = client.ws.send.bind(client.ws); client.ws.send = (frame, ...args) => { wire.push(String(frame)); return send(frame, ...args); };
  const service = new ProjectTransferService({ client });
  client.on('invite.requested', data => service.handleClaim(data));
  client.on('message', data => { void service.handleMessage(data); });
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await service.close(); await client.close(); await relay.close(); store.close();
    if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const input = { kind: 'LIBRARY', cwd: source, expectedDigest: 'a'.repeat(64) };
  const payload = Buffer.concat([Buffer.from('PRIVATE_LIBRARY_TRANSFER_MARKER_739128\n'), randomBytes(40000)]);
  const options = { authorize() {}, exportArchive(_source, file) { fs.writeFileSync(file, payload, { flag: 'wx', mode: 0o600 }); return {}; } };
  return { directory, source, recipient, store, identity, relay, client, service, wire, audit, input, options, payload, cleanup: close => cleanup.push(close) };
}
async function approve(f, share, fingerprint) {
  const pending = await until(() => f.service.status(share.shareId).pending[0]);
  assert.equal(pending.fingerprint, fingerprint());
  await assert.rejects(f.service.approveShare({ shareId: share.shareId, claimId: pending.claimId,
    confirmedFingerprint: createIdentity().certificate.id }), { code: 'CONFIRMATION_REQUIRED' });
  await f.service.approveShare({ shareId: share.shareId, claimId: pending.claimId, confirmedFingerprint: pending.fingerprint });
}
function receive(f, share, importArchive, extra = {}) {
  return importProjectShare({ expectedKind: 'LIBRARY', code: share.code, cwd: f.recipient,
    expectedSenderFingerprint: f.identity.certificate.id, url: f.relay.audience, allowInsecureLocal: true,
    onIdentity: extra.onIdentity, importArchive, ...extra });
}

test('one pasted Library capability verifies sender and archive, authorizes once and transfers without fingerprint prompts', async t => {
  const f = await fixture(t), share = await f.service.createShare({ ...f.input, approval: 'code' }, f.options);
  const parsed = decodeLibraryCode(share.code), phases = [], progress = [];
  assert.equal(classifyProjectShareCode(share.code), 'LIBRARY'); assert.equal(parsed.fingerprint, f.identity.certificate.id);
  const result = await importProjectShare({ expectedKind: 'LIBRARY', code: share.code, cwd: f.recipient,
    url: f.relay.audience, allowInsecureLocal: true, onPhase: phase => phases.push(phase), onProgress: value => progress.push(value),
    importArchive(file) { assert.deepEqual(fs.readFileSync(file), f.payload); return { installed: true }; } });
  assert.deepEqual(result, { installed: true }); assert.deepEqual(phases, ['connecting', 'downloading', 'checking']);
  assert.equal(progress.at(-1).received, f.payload.length); assert.equal(progress.at(-1).total, f.payload.length);
  assert.equal(f.service.status(share.shareId).state, 'complete');
  const exposed = JSON.stringify([f.wire, f.audit, f.store.db.prepare('SELECT data FROM invitations').all(), f.store.db.prepare('SELECT data FROM grants').all()]);
  assert.ok(!exposed.includes(parsed.secret)); assert.ok(!exposed.includes(share.code)); assert.ok(!exposed.includes('PRIVATE_LIBRARY_TRANSFER_MARKER_739128'));
  await assert.rejects(importProjectShare({ expectedKind: 'LIBRARY', code: share.code, cwd: f.recipient, url: f.relay.audience,
    allowInsecureLocal: true, importArchive() { assert.fail('A code cannot be reused'); } }), { code: 'INVITE_UNAVAILABLE' });
});

for (const field of [3, 4]) test(`altered code ${field === 3 ? 'secret' : 'archive pin'} cannot read even the manifest`, async t => {
  const f = await fixture(t), share = await f.service.createShare({ ...f.input, approval: 'code' }, f.options);
  const parts = share.code.split('.'); parts[field] = Buffer.alloc(32, 42).toString('base64url'); let read = false;
  await assert.rejects(importProjectShare({ expectedKind: 'LIBRARY', code: parts.join('.'), cwd: f.recipient,
    url: f.relay.audience, allowInsecureLocal: true, onProgress() { read = true; }, importArchive() { read = true; } }), { code: 'FORBIDDEN' });
  assert.equal(read, false); await until(() => f.service.status(share.shareId).state === 'revoked');
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'relay', 'shares', share.shareId)), false);
});

test('malformed capabilities and wrong resource kinds fail locally without granting authority', async t => {
  const f = await fixture(t), share = await f.service.createShare({ ...f.input, approval: 'code' }, f.options);
  for (const value of [share.code + '.extra', share.code.slice(0, -1), share.code.replace('.','..')]) {
    assert.throws(() => classifyProjectShareCode(value), { code: 'INVALID_REQUEST' });
  }
  await assert.rejects(importTerminalShare({ code: share.code, cwd: f.recipient, url: f.relay.audience, allowInsecureLocal: true }), { code: 'FORBIDDEN' });
  const parsed = decodeLibraryCode(share.code);
  await assert.rejects(importProjectShare({ expectedKind: 'LIBRARY', code: share.code, cwd: f.recipient,
    expectedSenderFingerprint: createIdentity().certificate.id, importArchive() {}, url: f.relay.audience, allowInsecureLocal: true }), { code: 'FORBIDDEN' });
  assert.equal(f.service.status(share.shareId).state, 'open'); assert.ok(parsed.secret);
});

test('a Relay-token holder without the private code proof receives no archive metadata and loses its provisional grant', async t => {
  const f = await fixture(t), share = await f.service.createShare({ ...f.input, approval: 'code' }, f.options);
  const recipient = new RelayClient({ url: f.relay.audience, identity: createIdentity(), allowInsecureLocal: true, autoReconnect: false });
  f.cleanup(() => recipient.close()); await recipient.connect();
  const claim = await recipient.claim(decodeLibraryCode(share.code).code);
  const decision = await until(async () => { const value = await recipient.claimStatus(claim.claimId); return value.state === 'approved' && value; });
  recipient.trustPeer(f.identity.certificate);
  const reply = once(recipient, 'message', { signal: AbortSignal.timeout(3000) });
  await recipient.send(decision.grant.id, { v: 1, protocol: 'bzzy-project-transfer', type: 'request', id: randomUUID(), op: 'manifest', params: {} });
  const response = (await reply)[0].payload;
  assert.equal(response.ok, false); assert.equal(response.error.code, 'FORBIDDEN'); assert.equal(response.result, undefined);
  const original = Date.now; Date.now = () => original() + 16000;
  try { await until(() => f.service.status(share.shareId).state === 'expired'); }
  finally { Date.now = original; }
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'relay', 'shares', share.shareId)), false);
});

test('simultaneous code imports queue behind the bounded active transfer without overlapping imports', async t => {
  const f = await fixture(t), shares = await Promise.all([f.service.createShare({ ...f.input, approval: 'code' }, f.options), f.service.createShare({ ...f.input, approval: 'code' }, f.options)]);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let active = 0, maximum = 0, calls = 0;
  const tasks = shares.map(share => importProjectShare({ expectedKind: 'LIBRARY', code: share.code, cwd: f.recipient,
    url: f.relay.audience, allowInsecureLocal: true, async importArchive() {
      active++; calls++; maximum = Math.max(maximum, active); entered.resolve(); await release.promise; active--; return { installed: true };
    } }));
  await entered.promise; await delay(100); assert.equal(calls, 1); release.resolve();
  assert.deepEqual(await Promise.all(tasks), [{ installed: true }, { installed: true }]); assert.equal(maximum, 1);
});

test('Core stop during code approval revokes the late grant and cannot revive the released archive', async t => {
  const f = await fixture(t), share = await f.service.createShare({ ...f.input, approval: 'code' }, f.options);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), approve = f.client.approve.bind(f.client);
  f.client.approve = async (...args) => { const result = await approve(...args); entered.resolve(); await release.promise; return result; };
  const recipient = new RelayClient({ url: f.relay.audience, identity: createIdentity(), allowInsecureLocal: true, autoReconnect: false });
  f.cleanup(() => recipient.close()); await recipient.connect(); await recipient.claim(decodeLibraryCode(share.code).code);
  await entered.promise; await f.service.close(); release.resolve();
  await until(() => f.store.grantsFor(f.identity.certificate.id).length === 0);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'relay', 'shares', share.shareId)), false);
});

test('typed Library shares require trusted registries and cannot be received by terminal or unreviewed importers', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.createShare(f.input), { code: 'OPERATION_DENIED' });
  await assert.rejects(f.service.createShare(f.input, { authorize() {} }), { code: 'OPERATION_DENIED' });
  const share = await f.service.createShare(f.input, f.options);
  assert.match(share.code, /^BZZY-LIBRARY-/); assert.equal(share.kind, 'LIBRARY');
  assert.equal(classifyProjectShareCode(share.code), 'LIBRARY');
  assert.equal(classifyProjectShareCode(share.qr, { allowInsecureLocal: true }), 'LIBRARY');
  assert.throws(() => classifyProjectShareCode(share.code + 'secret-input'), error => error.code === 'INVALID_REQUEST' && !error.message.includes('secret-input'));
  assert.throws(() => classifyProjectShareCode(share.code.replace('LIBRARY', 'PAIR')), { code: 'INVALID_REQUEST' });
  for (const excludeGoalIds of [['not-a-goal'], ['template:' + 'a'.repeat(64), 'template:' + 'a'.repeat(64)], Array(1025).fill('template:' + 'a'.repeat(64))]) {
    await assert.rejects(f.service.createShare({ ...f.input, excludeGoalIds }, f.options), { code: 'INVALID_REQUEST' });
  }
  const input = { code: share.code, cwd: f.recipient, expectedSenderFingerprint: f.identity.certificate.id, onIdentity() {},
    url: f.relay.audience, allowInsecureLocal: true };
  await assert.rejects(importTerminalShare(input), { code: 'INVALID_REQUEST' });
  await assert.rejects(importProjectShare({ ...input, expectedKind: 'LIBRARY' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => importLibraryShare(input), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(f.service.status(share.shareId).state, 'open');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM grants').get().n, 0);
});

test('local Library selection rejects malformed pins before runtime, export or invitation creation', async t => {
  const f = await fixture(t), facade = new CoreTerminalSharing();
  const entry = { kind: 'skill', scope: 'global', name: 'response-review', id: 'response-review', revision: 1, version: 'b'.repeat(64) };
  const marker = 'PRIVATE_INVALID_SELECTION_738164';
  const invalid = [
    { kinds: null }, { kinds: [] }, { kinds: ['agent', 'agent'] }, { kinds: [marker] }, { kinds: Array(1) },
    { approval: null }, { approval: true }, { approval: 'always' },
    { excludeGoalIds: null }, { excludeGoalIds: Array(1) }, { kinds: ['agent'], excludeGoalIds: ['template:' + 'a'.repeat(64)] },
    { excludeEntries: null }, { excludeEntries: Array(1) }, { excludeEntries: Array(1025).fill(entry) },
    { excludeEntries: [{ ...entry, revision: 0 }] }, { excludeEntries: [{ ...entry, version: marker }] },
    { excludeEntries: [{ ...entry, id: 'control\u0085character' }] },
    { excludeEntries: [{ ...entry, reason: marker }] }, { excludeEntries: [{ ...entry, name: undefined }] },
    { excludeEntries: [entry, { ...entry, id: 'different-id' }] },
    { kinds: ['agent'], excludeEntries: [entry] }, { [marker]: true },
  ];
  let exported = 0;
  for (const selected of invalid) {
    const reject = error => error.code === 'INVALID_REQUEST' && !error.message.includes(marker);
    await assert.rejects(f.service.createShare({ ...f.input, ...selected }, { ...f.options, exportArchive() { exported++; } }), reject);
    const { kind: _kind, ...input } = f.input;
    await assert.rejects(facade.createLibraryShare({ ...input, ...selected }), reject);
  }
  await assert.rejects(facade.createLibraryShare({ cwd: marker, expectedDigest: 'a'.repeat(64) }), { code: 'INVALID_REQUEST' });
  await assert.rejects(facade.createLibraryShare({ cwd: f.source, expectedDigest: marker }), { code: 'INVALID_REQUEST' });
  await assert.rejects(facade.createLibraryShare({ cwd: f.source, expectedDigest: 'a'.repeat(64), ttlSeconds: 0 }), { code: 'INVALID_REQUEST' });
  assert.equal(exported, 0); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM invitations').get().n, 0);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'relay', 'shares')), false);
});

test('Library selection detaches owner arrays and entry pins from the prepared source context', async t => {
  const f = await fixture(t);
  const selected = { kinds: ['skill', 'agent', 'goal'], excludeGoalIds: ['template:' + 'a'.repeat(64)],
    excludeEntries: [{ kind: 'skill', scope: 'global', name: 'response-review', id: 'response-review', revision: 1, version: 'b'.repeat(64) }] };
  const expected = structuredClone(selected); expected.kinds.sort();
  assert.deepEqual(libraryShareSelection(selected), expected);
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const sharing = f.service.createShare({ ...f.input, ...selected }, { ...f.options, async exportArchive(source, file) {
    entered.resolve(); await resume.promise;
    assert.equal(source.cwd, f.source); assert.equal(source.expectedDigest, f.input.expectedDigest);
    assert.deepEqual({ kinds: source.kinds, excludeGoalIds: source.excludeGoalIds, excludeEntries: source.excludeEntries }, expected);
    return f.options.exportArchive(source, file);
  } });
  await entered.promise;
  selected.kinds.push('workflow'); selected.excludeGoalIds.length = 0;
  selected.excludeEntries[0].revision = 2; selected.excludeEntries.push({ ...selected.excludeEntries[0], name: 'other-skill' });
  resume.resolve();
  const share = await sharing;
  assert.equal(share.kind, 'LIBRARY');
  assert.deepEqual(f.store.db.prepare('SELECT data FROM invitations').all().map(row => JSON.parse(row.data).spec.actions), [['import']]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM grants').get().n, 0);
});

test('gateway shares only reviewed kinds and exact exclusions, rejecting stale selections before a code exists', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.client.close();
  const { RelayGateway } = await import('../src/relay/gateway.js');
  const { importSkill, setSkillEnabled } = await import('../src/engine/skills.js');
  const { saveSubagentDefinition } = await import('../src/engine/subagent-definitions.js');
  const { previewLibraryExport, previewLibraryImport, discardDefinitionBundleReview } = await import('../src/engine/definition-bundle.js');
  const { runtimeInfo, runtimeRequest } = await import('../src/engine/runtime.js');
  const { identityAlive } = await import('../src/engine/process-identity.js');
  const reviews = [], preview = input => { const review = previewLibraryExport(input); reviews.push(review); return review; };
  const packagePath = path.join(f.directory, 'skill-package'); fs.mkdirSync(packagePath);
  fs.writeFileSync(path.join(packagePath, 'SKILL.md'), '---\nname: response-review\ndescription: Review synthetic response structure\n---\nInspect supplied synthetic responses.\n');
  fs.writeFileSync(path.join(packagePath, 'sample.txt'), 'Synthetic response sample.\n');
  const installed = importSkill(packagePath, { scope: 'global' });
  saveSubagentDefinition({ name: 'response-auditor', description: 'Inspect synthetic responses', instructions: 'Review supplied response structure.' }, { cwd: f.source, scope: 'project' });
  const original = preview({ cwd: f.source });
  const gateway = new RelayGateway({ identity: f.identity, url: f.relay.audience, allowInsecureLocal: true, autoReconnect: false });
  f.cleanup(async () => {
    for (const review of reviews) discardDefinitionBundleReview(review);
    await gateway.close();
    const info = runtimeInfo();
    if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let i = 0; i < 100 && info && identityAlive(info.identity); i++) await delay(20);
  });
  await gateway.start();
  const invitations = () => f.store.db.prepare('SELECT count(*) AS n FROM invitations').get().n;
  await assert.rejects(gateway.createLibraryShare({ cwd: f.source, kinds: ['agent'], expectedDigest: original.sourceDigest }), { code: 'STALE_REVIEW' });
  assert.equal(invitations(), 0);
  // Synthetic corruption must block skill export, while an Agent-only review
  // must neither read nor bundle that unrelated immutable resource.
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'skills', installed.name, installed.version, 'sample.txt'), 'Changed synthetic sample.\n');
  let blocked;
  assert.throws(() => previewLibraryExport({ cwd: f.source }), error => {
    blocked = error.blockedEntries?.[0]; return error.code === 'LIBRARY_BLOCKED_ENTRIES' && blocked?.kind === 'skill';
  });
  const pin = Object.fromEntries(['kind', 'scope', 'name', 'id', 'revision', 'version'].map(field => [field, blocked[field]]));
  const omitted = preview({ cwd: f.source, kinds: ['agent', 'skill'], excludeEntries: [pin] });
  for (const change of [{ revision: pin.revision + 1 }, { version: '0'.repeat(64) }, { id: 'unrelated-skill' }]) {
    await assert.rejects(gateway.createLibraryShare({ cwd: f.source, kinds: omitted.kinds, excludeEntries: [{ ...pin, ...change }], expectedDigest: omitted.sourceDigest }), { code: 'STALE_REVIEW' });
  }
  await assert.rejects(gateway.createLibraryShare({ cwd: f.source, kinds: ['agent'], excludeEntries: [pin], expectedDigest: omitted.sourceDigest }), { code: 'INVALID_REQUEST' });
  assert.equal(invitations(), 0);
  const receiveAgent = async input => {
    const share = await gateway.createLibraryShare({ cwd: f.source, ...input });
    let fingerprint;
    const importing = receive(f, share, async file => {
      const review = previewLibraryImport(file, { cwd: f.recipient }); reviews.push(review);
      assert.deepEqual({ skills: review.totals.skills, agents: review.totals.agents, workflows: review.totals.workflows, goals: review.totals.goals },
        { skills: 0, agents: 1, workflows: 0, goals: 0 });
      assert.deepEqual(review.entries.map(entry => [entry.kind, entry.name]), [['agent', 'response-auditor']]);
      return { reviewed: true };
    }, { onIdentity: value => { fingerprint = value.recipientFingerprint; } });
    const pending = await until(() => gateway.projectShareStatus(share.shareId).pending[0]);
    assert.equal(pending.fingerprint, fingerprint);
    await gateway.approveProjectShare({ shareId: share.shareId, claimId: pending.claimId, confirmedFingerprint: fingerprint });
    assert.deepEqual(await importing, { reviewed: true });
    assert.equal(gateway.projectShareStatus(share.shareId).state, 'complete');
  };
  const agentOnly = preview({ cwd: f.source, kinds: ['agent'] });
  await receiveAgent({ kinds: agentOnly.kinds, expectedDigest: agentOnly.sourceDigest });
  await receiveAgent({ kinds: omitted.kinds, excludeEntries: [pin], expectedDigest: omitted.sourceDigest });
  const count = invitations();
  setSkillEnabled(installed.id, !installed.enabled, installed.revision, { scope: 'global' });
  await assert.rejects(gateway.createLibraryShare({ cwd: f.source, kinds: omitted.kinds, excludeEntries: [pin], expectedDigest: omitted.sourceDigest }), { code: 'STALE_REVIEW' });
  assert.equal(invitations(), count);
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'relay', 'shares')), []);
});

test('an actual encrypted multi-chunk Library transfer commits before completion without exposing plaintext or codes', async t => {
  const f = await fixture(t), share = await f.service.createShare(f.input, f.options), progress = [];
  let recipientFingerprint, committed = false;
  const importing = receive(f, share, async (file, cwd, context) => {
    assert.equal(cwd, f.recipient); assert.equal(context.sourceFingerprint, f.identity.certificate.id);
    assert.equal(f.service.status(share.shareId).state, 'approved');
    await context.authorize();
    assert.deepEqual(fs.readFileSync(file), f.payload); committed = true;
    return { imported: true };
  }, { onIdentity: value => { recipientFingerprint = value.recipientFingerprint; }, onProgress: value => progress.push(value) });
  await approve(f, share, () => recipientFingerprint);
  assert.deepEqual(await importing, { imported: true }); assert.equal(committed, true);
  assert.equal(f.service.status(share.shareId).state, 'complete');
  assert.ok(progress.length > 2); assert.equal(progress.at(-1).received, f.payload.length);
  assert.ok(!f.wire.join('').includes('PRIVATE_LIBRARY_TRANSFER_MARKER_739128'));
  assert.ok(!JSON.stringify(f.audit).includes(share.code));
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM invitations').all()).includes(share.code));
  const storage = path.join(process.env.BZZY_HOME, 'relay', 'shares', share.shareId);
  assert.equal(fs.existsSync(storage), false);
});

test('cancelled Library review revokes its grant and removes the source archive without completing the share', async t => {
  const f = await fixture(t), share = await f.service.createShare(f.input, f.options);
  let recipientFingerprint, called = 0;
  const importing = receive(f, share, async () => { called++; throw Object.assign(new Error('Cancelled fixture review.'), { code: 'CANCELLED' }); },
    { onIdentity: value => { recipientFingerprint = value.recipientFingerprint; } });
  const rejected = assert.rejects(importing, { code: 'CANCELLED' });
  await approve(f, share, () => recipientFingerprint); await rejected;
  await until(() => f.service.status(share.shareId).state === 'revoked');
  assert.equal(called, 1); assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'relay', 'shares', share.shareId)), false);
  assert.ok(f.store.db.prepare('SELECT data FROM grants').all().every(row => JSON.parse(row.data).revokedAt));
});

test('revocation while Library review is open prevents the local commit', async t => {
  const f = await fixture(t), share = await f.service.createShare(f.input, f.options);
  let recipientFingerprint, committed = false;
  const importing = receive(f, share, async (_file, _cwd, context) => {
    await f.service.revokeShare(share.shareId);
    await context.authorize(); committed = true;
  }, { onIdentity: value => { recipientFingerprint = value.recipientFingerprint; } });
  const rejected = assert.rejects(importing);
  await approve(f, share, () => recipientFingerprint); await rejected;
  assert.equal(committed, false); assert.equal(f.service.status(share.shareId).state, 'revoked');
});

test('a Relay without Library support reports an upgrade requirement and cleans its prepared archive', async t => {
  const f = await fixture(t), original = f.client.createInvitation;
  f.client.createInvitation = async () => { throw Object.assign(new Error('Old Relay rejects purpose.'), { code: 'INVALID_PURPOSE' }); };
  await assert.rejects(f.service.createShare(f.input, f.options), { code: 'RELAY_UPGRADE_REQUIRED' });
  f.client.createInvitation = original;
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'relay', 'shares')), []);
});

test('a mismatched inner transfer kind is rejected before any Library importer runs', async t => {
  const f = await fixture(t), share = await f.service.createShare(f.input, f.options), send = f.client.send.bind(f.client);
  f.client.send = (grantId, payload, options) => send(grantId, payload?.result?.format === 'bzzy-project-zip'
    ? { ...payload, result: { ...payload.result, kind: 'TERMINAL' } } : payload, options);
  let recipientFingerprint, called = false;
  const importing = receive(f, share, async () => { called = true; }, { onIdentity: value => { recipientFingerprint = value.recipientFingerprint; } });
  const rejected = assert.rejects(importing, { code: 'INVALID_REQUEST' });
  await approve(f, share, () => recipientFingerprint); await rejected;
  assert.equal(called, false);
  await until(() => f.service.status(share.shareId).state === 'revoked');
});

for (const enable of [false, true, 'subset', 'automatic', 'cancel']) test(`four-kind Library uses an independent recipient Core home (review ${enable})`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.client.close();
  const { RelayGateway } = await import('../src/relay/gateway.js');
  const { importSkill } = await import('../src/engine/skills.js');
  const { saveSubagentDefinition } = await import('../src/engine/subagent-definitions.js');
  const { saveWorkflow } = await import('../src/engine/workflows.js');
  const { createSession, saveSession } = await import('../src/engine/store.js');
  const { newGoal } = await import('../src/engine/goals.js');
  const { saveGoalTemplate } = await import('../src/engine/goal-templates.js');
  const { BUILTINS } = await import('../src/engine/providers.js');
  const { previewLibraryExport, discardDefinitionBundleReview } = await import('../src/engine/definition-bundle.js');
  const { runtimeInfo, runtimeRequest } = await import('../src/engine/runtime.js');
  const { identityAlive } = await import('../src/engine/process-identity.js');
  const packagePath = path.join(f.directory, 'skill-package'); fs.mkdirSync(packagePath);
  fs.writeFileSync(path.join(packagePath, 'SKILL.md'), '---\nname: response-review\ndescription: Review synthetic response structure\n---\nInspect supplied synthetic responses.\n');
  fs.writeFileSync(path.join(packagePath, 'sample.txt'), randomBytes(40000).toString('base64'));
  importSkill(packagePath, { scope: 'global' });
  saveSubagentDefinition({ name: 'response-auditor', description: 'Inspect synthetic responses', instructions: 'Review supplied response structure.',
    provider: 'codex', model: 'source-only-model', effort: 'high' }, { cwd: f.source, scope: 'project' });
  saveWorkflow({ name: 'response-workflow', description: 'Structured response review', instructions: 'Read the stated objective and inspect supplied response evidence.' }, { cwd: f.source, scope: 'project' });
  const session = createSession(BUILTINS.codex, f.source, 'source-model');
  session.goal = { ...newGoal('Review synthetic HTTP responses'), status: 'complete', evidence: ['old-source-only-evidence'] }; saveSession(session);
  saveGoalTemplate({ objective: session.goal.objective });
  const review = previewLibraryExport({ cwd: f.source });
  const gateway = new RelayGateway({ identity: f.identity, url: f.relay.audience, allowInsecureLocal: true, autoReconnect: false });
  let child;
  f.cleanup(async () => {
    discardDefinitionBundleReview(review);
    if (child && child.exitCode == null) child.kill('SIGKILL');
    await gateway.close();
    const info = runtimeInfo();
    if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let i = 0; i < 100 && info && identityAlive(info.identity); i++) await delay(20);
  });
  await gateway.start();
  const share = await gateway.createLibraryShare({ cwd: f.source, expectedDigest: review.sourceDigest, ...(enable === 'automatic' ? { approval: 'code' } : {}) });
  const childFile = path.join(f.directory, 'receive.mjs');
  const transportURL = new URL('../src/relay/project-transfer.js', import.meta.url).href;
  const databaseURL = new URL('../src/engine/database.js', import.meta.url).href;
  const savedURL = new URL('../src/engine/saved-goals.js', import.meta.url).href;
  const skillsURL = new URL('../src/engine/skills.js', import.meta.url).href;
  fs.writeFileSync(childFile, `
    import { importLibraryShare } from ${JSON.stringify(transportURL)};
    import { listRecords } from ${JSON.stringify(databaseURL)};
    import { listSavedGoals } from ${JSON.stringify(savedURL)};
    import { createSkill } from ${JSON.stringify(skillsURL)};
    process.once('message', async input => {
      const abort = new AbortController();
      try {
        if (input.enable === 'automatic') createSkill({ name: 'response-review', description: 'Keep local controls.', instructions: 'Keep this recipient behavior.' }, { scope: 'global' });
        const result = await importLibraryShare({ ...input, signal: abort.signal,
          onIdentity: value => process.send({ type: 'identity', ...value }),
          onReview: review => {
            process.send({ type: 'review', totals: review.totals });
            if (input.enable === 'cancel') { setTimeout(() => abort.abort(), 5); return new Promise(() => {}); }
            if (input.enable === 'subset') return { approved: true, enable: true, entryIndexes: [review.entries.findIndex(row => row.kind === 'skill')] };
            if (input.enable === 'automatic') return { approved: true, enable: true };
            return { approved: true, enable: input.enable };
          }
        });
        process.send({ type: 'result', result, skills: listRecords('core.skill'), agents: listRecords('core.subagent.definition'),
          workflows: listRecords('core.workflow.definition'), goals: listSavedGoals().goals,
          executions: listRecords('execution').length, sessions: listRecords('session').length });
        process.disconnect();
      } catch (error) {
        if (input.enable === 'cancel' && error.name === 'AbortError') {
          process.send({ type: 'cancelled', skills: listRecords('core.skill').length, agents: listRecords('core.subagent.definition').length,
            goals: listSavedGoals().total, executions: listRecords('execution').length }); process.disconnect();
        } else { process.send({ type: 'error', code: error.code, message: error.message }); process.disconnect(); process.exitCode = 1; }
      }
    });
  `);
  child = fork(childFile, [], { execPath: process.execPath, env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(),
    BZZY_HOME: path.join(f.directory, 'recipient-private') }, silent: true });
  const messages = [], received = Promise.withResolvers(); let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.on('message', value => { messages.push(value); if (['result', 'cancelled'].includes(value.type)) received.resolve(value); if (value.type === 'error') received.reject(new Error(JSON.stringify(value))); });
  child.on('error', received.reject);
  child.on('exit', code => { if (code !== 0) received.reject(new Error(`Recipient exited ${code}: ${stderr}`)); });
  child.send({ code: share.code, cwd: f.recipient, ...(enable === 'automatic' ? {} : { expectedSenderFingerprint: f.identity.certificate.id }),
    url: f.relay.audience, allowInsecureLocal: true, enable });
  if (enable !== 'automatic') {
    const pending = await until(() => gateway.projectShareStatus(share.shareId).pending[0]);
    assert.equal(pending.fingerprint, messages.find(value => value.type === 'identity')?.recipientFingerprint);
    await gateway.approveProjectShare({ shareId: share.shareId, claimId: pending.claimId, confirmedFingerprint: pending.fingerprint });
  }
  const imported = await received.promise;
  if (enable === 'cancel') {
    assert.deepEqual(imported, { type: 'cancelled', skills: 0, agents: 0, goals: 0, executions: 0 });
    await until(() => gateway.projectShareStatus(share.shareId).state === 'revoked');
    assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'relay', 'shares', share.shareId)), false);
    return;
  }
  if (enable === 'subset') {
    assert.equal(imported.skills.length, 1); assert.equal(imported.skills[0].enabled, true);
    assert.equal(imported.agents.length, 0); assert.equal(imported.workflows.length, 0); assert.equal(imported.goals.length, 0);
    assert.equal(imported.executions, 0); assert.equal(imported.sessions, 0);
    assert.equal(gateway.projectShareStatus(share.shareId).state, 'complete'); return;
  }
  if (enable === 'automatic') {
    assert.equal(imported.skills.length, 1); assert.equal(imported.skills[0].enabled, false); assert.equal(imported.skills[0].description, 'Keep local controls.');
    assert.equal(imported.result.skills.length, 0); assert.equal(imported.result.agents.length, 1); assert.equal(imported.result.skipped.length, 1);
    assert.equal(imported.agents.length, 1); assert.equal(imported.agents[0].enabled, true);
    assert.equal(imported.workflows.length, 1); assert.equal(imported.goals.length, 1);
    assert.equal(imported.executions, 0); assert.equal(imported.sessions, 0);
    assert.equal(imported.result.alreadyImported, false); assert.equal(gateway.projectShareStatus(share.shareId).state, 'complete'); return;
  }
  assert.equal(imported.skills.length, 1); assert.equal(imported.agents.length, 1);
  assert.equal(imported.skills[0].enabled, enable); assert.equal(imported.agents[0].enabled, enable);
  assert.equal(imported.agents[0].provider, undefined); assert.equal(imported.agents[0].model, undefined);
  assert.equal(imported.workflows.length, 1); assert.equal(imported.goals.length, 1);
  assert.equal(imported.goals[0].objective, 'Review synthetic HTTP responses'); assert.equal(imported.goals[0].status, null);
  assert.equal(imported.executions, 0); assert.equal(imported.sessions, 0);
  assert.deepEqual(messages.find(value => value.type === 'review').totals.skills, 1);
  assert.equal(gateway.projectShareStatus(share.shareId).state, 'complete');
});
