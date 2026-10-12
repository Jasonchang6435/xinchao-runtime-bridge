const MAX_EVENT_BYTES = 65_536;

export class SseParser {
  #buffer = '';
  #event = 'message';
  #data = [];
  #eventSize = 0;

  push(chunk) {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_EVENT_BYTES) throw new Error('SSE event exceeds limit');
    const output = [];
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) break;
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const event = this.#consumeLine(line);
      if (event) output.push(event);
    }
    return output;
  }

  finish() {
    const output = [];
    if (this.#buffer) {
      const event = this.#consumeLine(this.#buffer.endsWith('\r') ? this.#buffer.slice(0, -1) : this.#buffer);
      if (event) output.push(event);
      this.#buffer = '';
    }
    const final = this.#dispatch();
    if (final) output.push(final);
    return output;
  }

  #consumeLine(line) {
    if (line === '') return this.#dispatch();
    if (line.startsWith(':')) return null;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.#event = value || 'message';
    if (field === 'data') {
      this.#eventSize += value.length;
      if (this.#eventSize > MAX_EVENT_BYTES) throw new Error('SSE event exceeds limit');
      this.#data.push(value);
    }
    return null;
  }

  #dispatch() {
    if (this.#data.length === 0) {
      this.#event = 'message';
      return null;
    }
    const event = Object.freeze({ event: this.#event, data: this.#data.join('\n') });
    this.#event = 'message';
    this.#data = [];
    this.#eventSize = 0;
    return event;
  }
}

export async function* parseSseBody(body, signal, { onActivity = () => {} } = {}) {
  if (!body) throw new Error('SSE response has no body');
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      for (const event of parser.push(decoder.decode(value, { stream: true }))) yield event;
    }
    const tail = decoder.decode();
    for (const event of parser.push(tail)) yield event;
    for (const event of parser.finish()) yield event;
  } finally {
    reader.releaseLock();
  }
}
