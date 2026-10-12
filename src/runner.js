import { deliverToInjector } from './injector.js';
import { safeError } from './logger.js';
import { parseStreamEvent } from './protocol.js';
import { parseSseBody } from './sse-parser.js';

async function injectWithBoundedRetry(envelope, config, options) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await deliverToInjector(envelope, config, options);
      return;
    } catch (error) {
      lastError = error;
      options.logger?.warn('injector delivery failed', {
        deliveryId: envelope.deliveryId,
        attempt,
        error: safeError(error),
      });
    }
  }
  throw lastError;
}

export async function runBridge(config, client, logger, signal, {
  dryRun = false,
  onConnected = () => {},
  onActivity = () => {},
  onDelivery = () => {},
} = {}) {
  const body = await client.openStream(signal);
  let connected = false;
  const handled = new Set();

  for await (const rawEvent of parseSseBody(body, signal, { onActivity })) {
    const event = parseStreamEvent(rawEvent);
    if (event.kind === 'ignored') {
      logger.debug('ignored stream event', { event: event.event });
      continue;
    }
    if (event.kind === 'connected') {
      if (connected) throw new Error('duplicate connected event');
      connected = true;
      onConnected();
      logger.info('bridge stream connected');
      continue;
    }
    if (!connected) throw new Error('delivery received before connected handshake');
    if (handled.has(event.deliveryId)) {
      logger.debug('ignored duplicate delivery notification', { deliveryId: event.deliveryId });
      continue;
    }

    onDelivery();
    if (dryRun) {
      // Observe IDs only. Never retrieve private text, invoke an adapter, or
      // send either kind of ACK while testing against a production queue.
      handled.add(event.deliveryId);
      if (handled.size > 1_024) handled.delete(handled.values().next().value);
      logger.info('delivery observed without retrieval or acknowledgement', {
        deliveryId: event.deliveryId,
        dryRun: true,
      });
      continue;
    }

    const envelope = await client.fetchDelivery(event.deliveryId, signal);
    try {
      await injectWithBoundedRetry(envelope, config, { signal, logger });
    } catch (error) {
      logger.error('delivery remains pending', {
        deliveryId: event.deliveryId,
        error: safeError(error),
      });
      await client.reportFailure(event.deliveryId, 'injector_failed', signal);
      continue;
    }

    await client.acknowledge(event.deliveryId, signal);
    handled.add(event.deliveryId);
    if (handled.size > 1_024) handled.delete(handled.values().next().value);
    logger.info('delivery acknowledged', { deliveryId: event.deliveryId });
  }

  throw new Error(connected ? 'bridge stream ended' : 'bridge stream ended before handshake');
}
