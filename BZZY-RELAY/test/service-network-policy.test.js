import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isIP } from 'node:net';
import { APNsClient } from '../src/apns.js';
import { RelayStore } from '../src/store.js';
import { startRelay } from '../src/server.js';

// The deployed unit is part of the delivery contract: a passing shell push
// test cannot detect a cgroup that drops the background worker's Apple packets.
const unit = fs.readFileSync(new URL('../deploy/bzzy-relay.service', import.meta.url), 'utf8');
const setting = name => unit.split('\n').map(line => line.trim()).filter(line => line.startsWith(name + '='))
  .flatMap(line => line.slice(name.length + 1).split(/\s+/));

function addressValue(address) {
  if (isIP(address) === 4) return address.split('.').reduce((value, octet) => value * 256n + BigInt(octet), 0n);
  assert.equal(isIP(address), 6);
  const [left, right] = address.split('::');
  const first = left ? left.split(':') : [], last = right ? right.split(':') : [];
  const words = right === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last];
  return words.reduce((value, word) => value * 65536n + BigInt('0x' + word), 0n);
}
function covers(network, address) {
  if (network === 'localhost') return address === '::1' || isIP(address) === 4 && address.startsWith('127.');
  const [base, prefix] = network.split('/'), version = isIP(base);
  assert.ok(version && prefix !== undefined, 'Unit allows only explicit network ranges or localhost');
  if (version !== isIP(address)) return false;
  const shift = BigInt((version === 4 ? 32 : 128) - Number(prefix));
  return addressValue(base) >> shift === addressValue(address) >> shift;
}

test('service policy admits rotating Apple IPv4/IPv6 and local DNS while denying unrelated destinations', () => {
  assert.deepEqual(setting('IPAddressDeny'), ['any']);
  const allowed = setting('IPAddressAllow');
  assert.ok(!allowed.includes('any') && !allowed.includes('0.0.0.0/0') && !allowed.includes('::/0'));
  const approved = new Set(['localhost', '17.0.0.0/8', '2403:300::/32', '2620:149::/32', '2a01:b740::/32']);
  assert.ok(allowed.every(network => approved.has(network)), 'The shared template must not add unrelated networks or private resolver bindings');
  for (const address of ['127.0.0.1', '127.0.0.53', '::1', '17.188.128.1', '17.249.1.1',
    '2403:300:a42::1', '2620:149:a44::1', '2a01:b740:a42::1']) {
    assert.ok(allowed.some(network => covers(network, address)), `Service must admit loopback or published Apple address ${address}`);
  }
  for (const address of ['1.1.1.1', '169.254.169.254', '192.0.2.1', '2001:db8::1', '2606:4700:4700::1111']) {
    assert.ok(!allowed.some(network => covers(network, address)), `Service must not gain unrestricted egress to ${address}`);
  }
  assert.match(unit, /^User=bzzy-relay$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
});

test('APNs egress allowance does not expose a public Relay listener', async t => {
  const store = new RelayStore(); t.after(() => store.close());
  for (const host of ['0.0.0.0', '::', '192.0.2.1']) {
    await assert.rejects(startRelay({ store, host, allowInsecureLocal: true }), { code: 'LOOPBACK_PROXY_REQUIRED' });
  }
  const relay = await startRelay({ store, allowInsecureLocal: true });
  t.after(() => relay.close());
  assert.equal(relay.address.address, '127.0.0.1');
});

test('network allowance leaves APNs destinations fixed to the supported HTTPS endpoints', () => {
  // Constructor checks happen before any connection or signing operation.
  const configuration = { privateKey: {}, environment: 'sandbox' };
  for (const endpoint of ['https://example.invalid', 'http://api.sandbox.push.apple.com',
    'https://api.sandbox.push.apple.com:444', 'https://api.sandbox.push.apple.com/other']) {
    assert.throws(() => new APNsClient({ configuration, endpoint }), { code: 'APNS_CONFIGURATION_INVALID' });
  }
  const client = new APNsClient({ configuration });
  client.close();
});
