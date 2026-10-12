#!/usr/bin/env node
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BridgeClient } from './client.js';
import { loadConfig } from './config.js';
import { createLogger, safeError } from './logger.js';
import { runBridge } from './runner.js';

function integer(env, key, fallback, min, max) {
  const value = String(env[key] ?? fallback).trim();
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

export function loadCloudConfig(env = process.env) {
  const raw = String(env.DRY_RUN ?? 'true').trim().toLowerCase();
  if (!['true', 'false', '1', '0'].includes(raw)) throw new Error('DRY_RUN must be true or false');
  const dryRun = ['true', '1'].includes(raw);
  // The original CLI still supports process adapters. A cloud container cannot
  // inject into a user's browser or local terminal: require a real webhook.
  const bridge = loadConfig({ ...env, XINCHAO_BRIDGE_INJECTOR_MODE: env.XINCHAO_BRIDGE_INJECTOR_MODE ?? 'webhook' }, {
    requireInjector: !dryRun,
  });
  if (bridge.injector.mode !== 'webhook') throw new Error('cloud deployment requires webhook injector mode');
  if (!dryRun && !bridge.injector.webhookToken) throw new Error('live cloud delivery requires an independent webhook token');
  if (bridge.injector.webhookToken === bridge.machineToken) throw new Error('webhook token must differ from machine token');
  const retryMinMs = integer(env, 'XINCHAO_BRIDGE_RETRY_MIN_MS', 1000, 100, 60_000);
  const retryMaxMs = integer(env, 'XINCHAO_BRIDGE_RETRY_MAX_MS', 30_000, retryMinMs, 300_000);
  return Object.freeze({
    bridge, dryRun,
    port: integer(env, 'PORT', 8080, 1, 65535),
    retryMinMs, retryMaxMs,
    idleMs: integer(env, 'XINCHAO_BRIDGE_STREAM_IDLE_MS', 90_000, 1000, 600_000),
  });
}

export function reconnectDelay(config, failures, random = Math.random) {
  const base = Math.min(config.retryMaxMs, config.retryMinMs * 2 ** Math.min(failures, 20));
  return Math.min(config.retryMaxMs, Math.round(base * (1 + random() * 0.2)));
}

export function cloudStatus(config, state) {
  return {
    ok: true,
    service: 'xinchao-runtime-bridge',
    mode: config.dryRun ? 'dry-run' : 'live',
    connected: state.connected,
    ready: state.connected,
    deliveryEnabled: !config.dryRun,
    receiverConfigured: Boolean(config.bridge.injector.webhookUrl),
    phase: state.phase,
    noticesObserved: state.noticesObserved,
    reconnects: state.reconnects,
    connectedAt: state.connectedAt,
    lastActivityAt: state.lastActivityAt,
  };
}

export function dropRootPrivileges(runtime = process) {
  if (typeof runtime.getuid !== 'function' || runtime.getuid() !== 0) return;
  // Some cloud platforms override Docker USER. Clear supplementary groups
  // before irreversibly changing the worker's group and user to the image's
  // node account. Failure must stop startup rather than silently keep root.
  runtime.setgroups([]);
  runtime.setgid(1000);
  runtime.setuid(1000);
  if (runtime.getuid() !== 1000 || runtime.getgid() !== 1000) {
    throw new Error('cloud worker privilege drop failed');
  }
}

export async function startCloud(config, {
  host = '0.0.0.0',
  client = new BridgeClient(config.bridge),
  logger = createLogger(config.bridge.logLevel),
} = {}) {
  const shutdown = new AbortController();
  const state = { connected: false, phase: 'connecting', noticesObserved: 0, reconnects: 0, connectedAt: null, lastActivityAt: null };
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (!['/healthz', '/readyz'].includes(request.url)) { response.writeHead(404).end(); return; }
    const status = cloudStatus(config, state);
    response.writeHead(request.url === '/readyz' && !status.ready ? 503 : 200);
    response.end(JSON.stringify(status));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, host, resolve);
  });
  logger.info('cloud worker started', { dryRun: config.dryRun, receiverConfigured: Boolean(config.bridge.injector.webhookUrl) });

  const run = (async () => {
    let failures = 0;
    while (!shutdown.signal.aborted) {
      const attempt = new AbortController();
      const signal = AbortSignal.any([shutdown.signal, attempt.signal]);
      let lastActivity = Date.now();
      let connectedSince = null;
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > config.idleMs) attempt.abort(new Error('stream idle timeout'));
      }, Math.min(5000, Math.max(100, config.idleMs / 3)));
      watchdog.unref();
      try {
        state.phase = 'connecting';
        await client.check(signal);
        await runBridge(config.bridge, client, logger, signal, {
          dryRun: config.dryRun,
          onConnected() {
            connectedSince = Date.now();
            state.connected = true;
            state.connectedAt = new Date().toISOString();
            state.phase = config.dryRun ? 'observing-without-ack' : 'delivering';
          },
          onActivity() { lastActivity = Date.now(); state.lastActivityAt = new Date().toISOString(); },
          onDelivery() { state.noticesObserved += 1; },
        });
      } catch (error) {
        if (!shutdown.signal.aborted) logger.warn('cloud stream unavailable; reconnecting', { error: safeError(error) });
      } finally {
        clearInterval(watchdog);
        attempt.abort();
        state.connected = false;
      }
      if (shutdown.signal.aborted) break;
      if (connectedSince && Date.now() - connectedSince >= 60_000) failures = 0;
      const waitMs = reconnectDelay(config, failures++);
      state.phase = 'reconnecting';
      state.reconnects += 1;
      logger.info('cloud reconnect scheduled', { waitMs });
      try { await sleep(waitMs, undefined, { signal: shutdown.signal }); } catch { break; }
    }
    state.phase = 'stopped';
  })();

  return {
    server, state, done: run,
    async stop() {
      shutdown.abort(new Error('worker shutting down'));
      server.closeAllConnections();
      await Promise.all([run, new Promise((resolve) => server.close(resolve))]);
    },
  };
}

async function main() {
  dropRootPrivileges();
  const worker = await startCloud(loadCloudConfig());
  const stop = () => { void worker.stop().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await worker.done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Cloud configuration/startup error: ${safeError(error)}\n`);
    process.exitCode = 2;
  });
}
