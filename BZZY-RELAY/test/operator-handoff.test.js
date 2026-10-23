import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createIdentity } from '../src/identity.js';
import { RelayStore } from '../src/store.js';

test('operator enrollment preserves denied metadata and its read-only verifier detects reactivated access', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-operator-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.resolve(import.meta.dirname, '..'), helper = path.join(directory, 'operator-state.mjs');
  fs.copyFileSync(path.join(root, 'deploy/operator-state.mjs'), helper);
  fs.symlinkSync(root, path.join(directory, 'release'), 'dir');
  const source = createIdentity(), recipient = createIdentity(), target = createIdentity(), state = path.join(directory, 'state');
  const certificate = path.join(directory, 'host.public.json'), before = path.join(directory, 'before.json');
  fs.writeFileSync(certificate, JSON.stringify(target.certificate), { mode: 0o600 });
  const store = new RelayStore({ directory: state });
  t.after(() => store.close());
  store.provisionHost(source.certificate);
  const invitation = store.createInvitation(source.certificate.id, { kind: 'PAIR', resource: 'operator-fixture' });
  const claim = store.claim(invitation.code, recipient.certificate, () => true);
  const { grant } = store.decide(source.certificate.id, claim.claimId, true, recipient.certificate);
  store.revokeGrant(source.certificate.id, grant.id); store.revokeDevice(recipient.certificate.id);
  const run = (op, extra = []) => spawnSync(process.execPath, [helper, op, state, certificate, ...extra], { encoding: 'utf8' });
  const snapshot = run('snapshot'); assert.equal(snapshot.status, 0); fs.writeFileSync(before, snapshot.stdout, { mode: 0o600 });
  store.provisionHost(target.certificate);
  assert.equal(run('verify', [before]).status, 0); assert.equal(run('host-ready').status, 0);
  const changed = JSON.parse(store.db.prepare('SELECT data FROM grants WHERE id=?').get(grant.id).data);
  store.db.prepare('UPDATE grants SET data=? WHERE id=?').run(JSON.stringify({ ...changed, revokedAt: null }), grant.id);
  assert.equal(run('verify', [before]).status, 1);
  fs.writeFileSync(certificate, JSON.stringify({ ...target.certificate, signingSecret: target.signingSecret }));
  const privateInput = run('certificate'); assert.equal(privateInput.status, 1);
  assert.ok(!privateInput.stderr.includes(target.signingSecret));
});

test('service-account staging commands leave the administrator-private invocation directory', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-operator-cwd-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const privateDirectory = path.join(directory, 'administrator-only'); fs.mkdirSync(privateDirectory, { mode: 0o700 });
  // Replace only privilege switching; the real wrapper, clean environment and
  // Node subprocess spawning run unchanged. Production performs actual runuser.
  const runuser = path.join(directory, 'runuser-fixture');
  fs.writeFileSync(runuser, '#!/bin/sh\n[ "$1" = --user ] && [ "$2" = bzzy-relay ] && [ "$3" = -- ] || exit 2\nshift 3\nexec "$@"\n', { mode: 0o700 });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../deploy/operator-upgrade.sh'), 'utf8');
  const wrapper = source.split('\n').find(line => line.startsWith('as_relay() '));
  assert.ok(wrapper);
  const program = 'import assert from "node:assert/strict";import {spawnSync} from "node:child_process";assert.equal(process.cwd(),"/");const result=spawnSync(process.execPath,["-e","process.exit(0)"]);assert.equal(result.status,0);console.log("accessible-cwd-and-child");';
  const shell = 'STATE=/var/lib/bzzy-relay\n' + wrapper.replace('/usr/sbin/runuser', quote(runuser)) + '\nas_relay ' + quote(process.execPath) + ' --input-type=module -e ' + quote(program);
  const result = spawnSync('bash', ['-c', shell], { cwd: privateDirectory, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /accessible-cwd-and-child/);
});
