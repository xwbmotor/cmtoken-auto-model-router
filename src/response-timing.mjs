export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000];

export function observeLatency(timings, name, value) {
  if (!Number.isFinite(value) || value < 0) return;
  const h = timings[name] ||= { count: 0, sumMs: 0, buckets: Array(LATENCY_BUCKETS_MS.length).fill(0) };
  h.count += 1;
  h.sumMs += value;
  LATENCY_BUCKETS_MS.forEach((bound, i) => { if (value <= bound) h.buckets[i] += 1; });
}

// Timestamp complete SSE events; ignore role-only, heartbeat, usage and DONE.
// TTFT here means first nonempty content delta. Reasoning/tools have a separate
// firstOutputMs value so tool-only streams are not given a fake content TTFT.
export function createStreamTimingObserver(startedAt, now = Date.now) {
  let pending = Buffer.alloc(0);
  let firstContentMs = null;
  let firstOutputMs = null;
  let dataLines = [];
  let eventBytes = 0;
  let eventTooLarge = false;
  const dispatch = () => {
    const data = dataLines.join('\n');
    const ignored = eventTooLarge;
    dataLines = []; eventBytes = 0; eventTooLarge = false;
    if (ignored || !data) return;
    let value;
    try { value = JSON.parse(data); } catch { return; }
    const delta = value?.choices?.[0]?.delta || value?.choices?.[0]?.message;
    if (!delta) return;
    const content = typeof delta.content === 'string' && delta.content.length > 0;
    const output = content || (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0)
      || (typeof delta.reasoning === 'string' && delta.reasoning.length > 0)
      || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
      || (delta.function_call && Object.keys(delta.function_call).length > 0);
    if (firstOutputMs === null && output) firstOutputMs = Math.max(0, now() - startedAt);
    if (firstContentMs === null && content) firstContentMs = Math.max(0, now() - startedAt);
  };
  const feed = line => {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (clean === '') { dispatch(); return; }
    if (!clean.startsWith('data:') || eventTooLarge) return;
    const data = clean.slice(5).replace(/^ /, '');
    eventBytes += Buffer.byteLength(data);
    if (eventBytes > 1024 * 1024) { dataLines = []; eventTooLarge = true; return; }
    dataLines.push(data);
  };
  return {
    push(chunk) {
      if (firstContentMs !== null) return;
      const b = Buffer.from(chunk);
      pending = pending.length ? Buffer.concat([pending, b]) : b;
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        if (pending[i] === 10) { feed(pending.subarray(start, i).toString('utf8')); start = i + 1; }
      }
      pending = pending.subarray(start);
      // Malformed unterminated events must not cause unbounded buffering.
      if (pending.length > 1024 * 1024) { pending = Buffer.alloc(0); dataLines = []; eventTooLarge = true; }
    },
    finish() { if (pending.length) feed(pending.toString('utf8')); pending = Buffer.alloc(0); dispatch(); },
    snapshot() { return { firstContentMs, firstOutputMs }; }
  };
}
