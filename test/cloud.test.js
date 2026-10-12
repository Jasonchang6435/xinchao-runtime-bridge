import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadCloudConfig, startCloud, reconnectDelay, dropRootPrivileges } from '../src/cloud.js';
import { runBridge } from '../src/runner.js';

const env = {
  XINCHAO_BRIDGE_BASE_URL: 'https://heart.example.com',
  XINCHAO_BRIDGE_MACHINE_TOKEN: 'synthetic-machine-token-1234567890',
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await check()) return; await delay(20); }
  throw new Error('condition not reached');
}

test('cloud defaults to DRY_RUN=true without requiring a receiver', () => {
  const config = loadCloudConfig(env);
  assert.equal(config.dryRun, true);
  assert.equal(config.bridge.injector.mode, 'webhook');
  assert.equal(config.bridge.injector.webhookUrl, null);
  assert.equal(loadCloudConfig({ ...env, DRY_RUN: 'True' }).dryRun, true);
});

test('root startup drops supplementary groups, group and user in that order', () => {
  const calls = []; let uid = 0; let gid = 0;
  dropRootPrivileges({
    getuid: () => uid, getgid: () => gid,
    setgroups(value) { calls.push(['groups', value]); },
    setgid(value) { calls.push(['gid', value]); gid = value; },
    setuid(value) { calls.push(['uid', value]); uid = value; },
  });
  assert.deepEqual(calls, [['groups', []], ['gid', 1000], ['uid', 1000]]);
  dropRootPrivileges({ getuid: () => 501 });
  assert.throws(() => dropRootPrivileges({ getuid: () => 0, setgroups() { throw new Error('EPERM'); } }), /EPERM/);
});

test('live cloud mode requires a webhook and independent credential', () => {
  assert.throws(() => loadCloudConfig({ ...env, DRY_RUN: 'false' }), /WEBHOOK_URL/);
  assert.throws(() => loadCloudConfig({ ...env, DRY_RUN: 'false', XINCHAO_BRIDGE_WEBHOOK_URL: 'https://runtime.example.com/wake' }), /independent webhook token/);
  assert.throws(() => loadCloudConfig({ ...env, XINCHAO_BRIDGE_WEBHOOK_TOKEN: env.XINCHAO_BRIDGE_MACHINE_TOKEN }), /must differ/);
  assert.throws(() => loadCloudConfig({ ...env, XINCHAO_BRIDGE_INJECTOR_MODE: 'process' }), /webhook injector mode/);
});

test('invalid dry-run, insecure endpoints and invalid ports fail closed', () => {
  for (const raw of ['yes', 'tru', '"true"']) assert.throws(() => loadCloudConfig({ ...env, DRY_RUN: raw }), /DRY_RUN/);
  assert.throws(() => loadCloudConfig({ ...env, PORT: '0' }), /PORT/);
  assert.throws(() => loadCloudConfig({ ...env, XINCHAO_BRIDGE_BASE_URL: 'http://heart.internal' }), /HTTPS/);
});

test('reconnect backoff grows and is bounded', () => {
  const config = loadCloudConfig(env);
  assert.equal(reconnectDelay(config, 0, () => 0), 1000);
  assert.equal(reconnectDelay(config, 2, () => 0), 4000);
  assert.equal(reconnectDelay(config, 30, () => 1), 30_000);
});

test('dry-run observes and deduplicates IDs without retrieving text or sending any ACK', async () => {
  const ids = ['delivery-test-001', 'delivery-test-001'];
  const stream = 'event: connected\ndata: {"protocol":"xinchao-bridge-stream/1"}\n\n' + ids.map((deliveryId) =>
    `event: delivery\ndata: ${JSON.stringify({ protocol: 'xinchao-bridge-stream/1', deliveryId })}\n\n`).join('');
  const calls = [];
  const client = {
    async openStream() { return new Response(stream).body; },
    async fetchDelivery() { calls.push('fetch'); },
    async acknowledge() { calls.push('ack'); },
    async reportFailure() { calls.push('failure'); },
  };
  let notices = 0;
  await assert.rejects(runBridge(loadCloudConfig(env).bridge, client, logger, new AbortController().signal, {
    dryRun: true, onDelivery() { notices += 1; },
  }), /stream ended/);
  assert.deepEqual(calls, []);
  assert.equal(notices, 1);
});

async function upstream(t, { wrongAck = false, silent = false } = {}) {
  const calls = { streams: 0, fetched: 0, delivered: 0, failed: 0, injected: 0 };
  const streams = new Set();
  const deliveryId = 'delivery-cloud-test-001';
  const server = createServer(async (req, res) => {
    if (req.url === '/wake') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const value = JSON.parse(raw);
      calls.injected += 1;
      assert.equal(req.headers.authorization, 'Bearer synthetic-webhook-token-1234567890');
      assert.equal(value.deliveryId, deliveryId);
      res.end(JSON.stringify({ accepted: true, deliveryId: wrongAck ? 'wrong-id' : deliveryId })); return;
    }
    assert.equal(req.headers.authorization, `Bearer ${env.XINCHAO_BRIDGE_MACHINE_TOKEN}`);
    if (req.url === '/bridge/v1/health') { res.end(JSON.stringify({ protocol: 'xinchao-bridge-server/1', status: 'ok' })); return; }
    if (req.url === '/bridge/v1/events') {
      calls.streams += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: connected\ndata: {"protocol":"xinchao-bridge-stream/1"}\n\n');
      res.write(`event: delivery\ndata: ${JSON.stringify({ protocol: 'xinchao-bridge-stream/1', deliveryId })}\n\n`);
      streams.add(res);
      const timer = silent ? null : setInterval(() => res.write(': heartbeat\n\n'), 100);
      req.on('close', () => { clearInterval(timer); streams.delete(res); }); return;
    }
    if (req.url === `/bridge/v1/deliveries/${deliveryId}`) {
      calls.fetched += 1;
      res.end(JSON.stringify({ protocol: 'xinchao-runtime-wake/1', deliveryId, reason: 'self_signal', message: 'synthetic private text; never log this' })); return;
    }
    if (req.url === `/bridge/v1/deliveries/${deliveryId}/ack`) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const value = JSON.parse(raw);
      if (value.status === 'delivered') calls.delivered += 1;
      if (value.status === 'retryable_failed') calls.failed += 1;
      res.end('{}'); return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const res of streams) res.end(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, streams };
}

async function worker(t, base, extra = {}) {
  const config = { ...loadCloudConfig({ ...env, XINCHAO_BRIDGE_BASE_URL: base, XINCHAO_BRIDGE_ACCEPT_SELF_SIGNALS: 'true', ...extra }), port: 0, retryMinMs: 100, retryMaxMs: 200 };
  const running = await startCloud(config, { host: '127.0.0.1', logger });
  t.after(() => running.stop());
  return { ...running, base: `http://127.0.0.1:${running.server.address().port}` };
}

test('cloud health and readiness expose mode, and dry-run leaves upstream untouched', async (t) => {
  const u = await upstream(t);
  const w = await worker(t, u.base);
  await until(() => w.state.connected && w.state.noticesObserved === 1);
  const response = await fetch(w.base + '/readyz');
  const status = await response.json();
  assert.equal(response.status, 200);
  assert.equal(status.mode, 'dry-run');
  assert.equal(status.deliveryEnabled, false);
  assert.equal(status.receiverConfigured, false);
  assert.equal(status.phase, 'observing-without-ack');
  assert.equal(JSON.stringify(status).includes(env.XINCHAO_BRIDGE_MACHINE_TOKEN), false);
  assert.equal((await fetch(w.base + '/unknown')).status, 404);
  assert.equal((await fetch(w.base + '/healthz', { method: 'POST' })).status, 405);
  assert.deepEqual([u.calls.fetched, u.calls.delivered, u.calls.failed, u.calls.injected], [0, 0, 0, 0]);
});

test('cloud reconnects after an ended stream without consuming deliveries', async (t) => {
  const u = await upstream(t);
  const w = await worker(t, u.base);
  await until(() => w.state.connected);
  for (const response of u.streams) response.end();
  await until(() => u.calls.streams >= 2 && w.state.connected);
  assert.ok(w.state.reconnects >= 1);
  assert.equal(u.calls.fetched, 0);
  assert.equal(u.calls.delivered, 0);
});

test('silent streams time out and reconnect', async (t) => {
  const u = await upstream(t, { silent: true });
  const w = await worker(t, u.base, { XINCHAO_BRIDGE_STREAM_IDLE_MS: '1000' });
  await until(() => u.calls.streams >= 2);
  assert.ok(w.state.reconnects >= 1);
});

test('live mode ACKs only after a webhook confirms the matching delivery', async (t) => {
  const u = await upstream(t);
  await worker(t, u.base, { DRY_RUN: 'false', XINCHAO_BRIDGE_WEBHOOK_URL: u.base + '/wake', XINCHAO_BRIDGE_WEBHOOK_TOKEN: 'synthetic-webhook-token-1234567890' });
  await until(() => u.calls.delivered === 1);
  assert.equal(u.calls.injected, 1);
  assert.equal(u.calls.failed, 0);
});

test('incorrect webhook ACK never marks a delivery delivered', async (t) => {
  const u = await upstream(t, { wrongAck: true });
  await worker(t, u.base, { DRY_RUN: 'false', XINCHAO_BRIDGE_WEBHOOK_URL: u.base + '/wake', XINCHAO_BRIDGE_WEBHOOK_TOKEN: 'synthetic-webhook-token-1234567890' });
  await until(() => u.calls.failed === 1);
  assert.equal(u.calls.injected, 2);
  assert.equal(u.calls.delivered, 0);
});

test('unavailable upstream keeps liveness healthy and readiness false', async (t) => {
  const config = { ...loadCloudConfig(env), port: 0, retryMinMs: 100, retryMaxMs: 200 };
  const w = await startCloud(config, { host: '127.0.0.1', logger, client: { async check() { throw new Error('synthetic unavailable'); } } });
  t.after(() => w.stop());
  const base = `http://127.0.0.1:${w.server.address().port}`;
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/readyz')).status, 503);
  assert.equal(w.state.connected, false);
});
