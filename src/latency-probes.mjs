const MINUTE = 60000, DAY = 86400000, OFFSET = 8 * 3600000;
const dayAt = at => new Date(at + OFFSET).toISOString().slice(0, 10);
const defaults = { enabled: false, intervalMs: 900000, maxCallsPerDay: 144, timeoutMs: 20000, maxOutputTokens: 128 };

// Scheduling only: the caller owns HTTP, credentials, capacity and observations.
// Accepted means queued locally, not that an upstream call has already succeeded.
export function createLatencyProbeRunner({ observatory, getSettings, getModels, probe, hasFreshBusiness = () => false, now = Date.now }) {
  let running = false, pending = Promise.resolve(), lastError = null, storageBlocked = false;
  let lastDecision = null;
  const attempted = new Map();
  const settings = () => ({ ...defaults, ...getSettings() });
  const models = () => [...new Map(getModels().filter(m => m && m.id && m.enabled !== false).map(m => [m.id, m])).values()];
  const state = observatory.probeState;
  const blocked = () => storageBlocked || observatory.probeBudgetBlocked === true;
  const callsAt = at => state.day === dayAt(at) ? state.calls : 0;
  const lastAt = id => Math.max(state.modelLastAt[id] ?? -Infinity, attempted.get(id) ?? -Infinity);
  const nextDay = at => Math.floor((at + OFFSET) / DAY) * DAY + DAY - OFFSET;
  // Recompute against the last reservation, so repeated polling cannot push the due time forward.
  const pacedAt = (at, cfg) => state.day === dayAt(at) && state.lastRunAt != null
    ? state.lastRunAt + Math.max(MINUTE, (nextDay(at) - state.lastRunAt) / Math.max(1, cfg.maxCallsPerDay - callsAt(at) + 1)) : at;
  const reject = reason => { lastDecision = { at: now(), reason }; return { accepted: false, reason }; };

  async function persist() {
    const before = observatory.storage.persistErrors;
    try {
      await observatory.flush(true);
      if (observatory.storage.persistErrors !== before || observatory.probeBudgetBlocked) throw new Error('storage');
      return true;
    } catch {
      storageBlocked = true; lastError = 'storage';
      return false;
    }
  }

  function run({ manual = false } = {}) {
    const cfg = settings(), at = now();
    if (!manual && !cfg.enabled) return reject('disabled');
    if (running) return reject('busy');
    if (blocked()) return reject('storage');
    if (state.lastRunAt != null && at - state.lastRunAt < MINUTE) return reject('cooldown');
    if (callsAt(at) >= cfg.maxCallsPerDay) return reject('budget');
    if (!manual && at < pacedAt(at, cfg)) return reject('pacing');
    const eligible = models().filter(m => manual || at - lastAt(m.id) >= cfg.intervalMs)
      .filter(m => manual || !hasFreshBusiness(m))
      .sort((a, b) => lastAt(a.id) - lastAt(b.id));
    const model = eligible[0];
    if (!model) return reject(models().length && models().every(hasFreshBusiness) ? 'fresh_business' : 'no_model');

    // Reserve before returning: concurrent manual and timer triggers cannot overlap.
    running = true; lastError = null;
    if (state.day !== dayAt(at)) { state.day = dayAt(at); state.calls = 0; }
    state.calls++; state.lastRunAt = at; observatory.dirty = true;
    attempted.set(model.id, at);
    lastDecision = { at, model: model.id, reason: manual ? 'manual' : 'scheduled', outcome: 'queued' };
    pending = Promise.resolve().then(async () => {
      // A lost write must never result in an unaccounted upstream request.
      if (!await persist()) return;
      let result;
      try { result = await probe(model, cfg); }
      catch { result = { ok: false, errorCode: 'probe_failed' }; }
      // Do not refund skipped/failed/unknown calls: conservative across restarts.
      // A skipped model gets only an in-memory scheduling delay, no false sample age.
      if (!result?.skipped) state.modelLastAt[model.id] = at;
      if (!result?.ok) lastError = /^[a-zA-Z0-9_-]{1,64}$/.test(result?.errorCode ?? '')
        ? result.errorCode : result?.skipped ? 'skipped' : 'probe_failed';
      lastDecision = { at, model: model.id, reason: manual ? 'manual' : 'scheduled', outcome: result?.ok ? 'success' : lastError };
      observatory.dirty = true;
      await persist();
    }).catch(() => { lastError = 'probe_failed'; }).finally(() => { running = false; });
    return { accepted: true };
  }

  function snapshot() {
    const cfg = settings(), at = now(), available = models();
    let nextRunAt = null;
    if (cfg.enabled && !blocked() && available.length) {
      nextRunAt = Math.max(at, pacedAt(at, cfg), (state.lastRunAt ?? -Infinity) + MINUTE,
        Math.min(...available.map(m => lastAt(m.id) + cfg.intervalMs)));
      if (callsAt(at) >= cfg.maxCallsPerDay) {
        nextRunAt = Math.max(nextRunAt, Math.floor((at + OFFSET) / DAY) * DAY + DAY - OFFSET);
      }
    }
    return { enabled: cfg.enabled === true, running, lastRunAt: state.lastRunAt, nextRunAt, lastDecision,
      scheduleCheckMs: 300000, nextRunMeaning: 'earliest_eligible',
      models: available.map(m => ({ model: m.id, reason: hasFreshBusiness(m) ? 'fresh_business' : at - lastAt(m.id) < cfg.intervalMs ? 'model_interval' : 'needs_probe' })),
      callsToday: callsAt(at), maxCallsPerDay: cfg.maxCallsPerDay, lastError: blocked() ? 'storage' : lastError };
  }

  return { run, snapshot, done: () => pending };
}
