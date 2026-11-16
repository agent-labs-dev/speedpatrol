/** SSE event framing from the HTML standard, including CR, LF and CRLF across chunks.
 * Only events with a data field dispatch. EOF does not dispatch an unterminated event.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 */
export class EventFrames {
  private line = '';
  private afterCr = false;
  private event = '';
  private data = false;

  constructor(private readonly dispatch: (name: string) => void) {}

  push(text: string): void {
    for (const char of text) {
      if (this.afterCr && char === '\n') {
        this.afterCr = false;
        continue;
      }
      this.afterCr = char === '\r';
      if (char === '\r' || char === '\n') {
        this.acceptLine(this.line);
        this.line = '';
      } else this.line += char;
    }
  }

  private acceptLine(line: string): void {
    if (line === '') {
      if (this.data) this.dispatch(this.event || 'message');
      this.event = '';
      this.data = false;
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    if (field === 'data') this.data = true;
  }
}

export async function timeEventStream(
  response: Response,
  started: number,
  config: { events: Record<string, string>; endEvent?: string },
): Promise<Record<string, number>> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') {
    await response.body?.cancel();
    throw new Error('Streaming benchmark expected Content-Type: text/event-stream');
  }
  if (!response.body) throw new Error('Streaming response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const metrics: Record<string, number> = { bytes: 0 };
  let ended = false;
  const frames = new EventFrames((name) => {
    if (ended) return;
    const elapsed = performance.now() - started;
    metrics.first_event_ms ??= elapsed;
    for (const [metric, event] of Object.entries(config.events)) {
      if (name === event) metrics[metric] ??= elapsed;
    }
    if (name === config.endEvent) {
      ended = true;
      metrics.total_ms = elapsed;
    }
  });
  try {
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) {
        frames.push(decoder.decode());
        break;
      }
      metrics.bytes! += value.byteLength;
      frames.push(decoder.decode(value, { stream: true }));
    }
    metrics.total_ms ??= performance.now() - started;
    if (metrics.first_event_ms === undefined) throw new Error('Stream ended without a complete data event');
    for (const [metric, event] of Object.entries(config.events)) {
      if (metrics[metric] === undefined) throw new Error(`Stream ended before configured event: ${event}`);
    }
    if (config.endEvent && !ended) throw new Error(`Stream ended before completion event: ${config.endEvent}`);
    return metrics;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
