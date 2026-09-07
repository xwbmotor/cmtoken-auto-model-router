// Counts only attempts owned by this router process, not the entire MaaS pool.
// Reserve synchronously before any await; release exactly once on every exit path.
export function modelCapacity(model, routing = {}) {
  const configured = routing.loadBalancing?.limits?.[model.id];
  const n = Number(configured);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function loadAssessment(model, routing = {}, snapshot = {}) {
  const inflight = Math.max(0, Number(snapshot[model.id]?.inflight || 0));
  const capacity = modelCapacity(model, routing);
  const enabled = routing.loadBalancing?.enabled === true && capacity !== null;
  const utilization = capacity === null ? null : inflight / capacity;
  const weight = Number(routing.loadBalancing?.penaltyWeight ?? 0.2);
  return { inflight, capacity, utilization, scope: 'router_process',
    penalty: enabled ? weight * Math.min(1, utilization) ** 2 : 0,
    saturated: enabled && inflight >= capacity };
}

export function createModelLoadTracker() {
  const active = new Map();
  return {
    snapshot() { return Object.fromEntries([...active].map(([id, inflight]) => [id, { inflight }])); },
    acquire(model, routing) {
      const inflight = active.get(model.id) || 0;
      if (loadAssessment(model, routing, { [model.id]: { inflight } }).saturated) return null;
      active.set(model.id, inflight + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = (active.get(model.id) || 1) - 1;
        if (next === 0) active.delete(model.id); else active.set(model.id, next);
      };
    }
  };
}
