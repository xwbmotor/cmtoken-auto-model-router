import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETENTION = 14 * 86400000;
export class OperationsEvidence {
  constructor({ path, now = Date.now } = {}) {
    this.path = path; this.now = now; this.events = []; this.samples = []; this.pending = new Map();
    this.changes = []; this.revision = null; this.storageErrors = 0; this.lastCheck = 0; this.writing = null;
  }
  async restore() {
    if (!this.path) return;
    try {
      if ((await stat(this.path)).size > 4 * 1024 * 1024) throw Error('oversize');
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.events) || !Array.isArray(data.changes)) throw Error('schema');
      this.events = data.events.filter(e => typeof e.id === 'string' && Number.isFinite(e.openedAt) && e.openedAt <= this.now() && ['active', 'resolved', 'closed'].includes(e.status)).slice(-200);
      this.changes = data.changes.slice(-20); this.revision = data.revision;
      // A restart supplies no evidence of recovery.
      for (const e of this.events) if (e.status === 'active') e.awaitingData = true;
    } catch (error) { if (error.code !== 'ENOENT') this.storageErrors++; }
  }
  record(row, requestId) {
    if (row.source !== 'business') return;
    // Never retain request bodies, credentials, headers or generated answers.
    this.samples.push({ requestId: String(requestId || '').slice(0, 160), at: row.at, model: row.model, scope: row.scope, inference: row.inference,
      stream: row.stream, reasoning: row.reasoning, inputBand: row.inputBand, outputBand: row.outputBand,
      ok: row.ok, failureScope: row.failureScope, attemptMs: row.attemptMs, upstreamFirstOutputMs: row.upstreamFirstOutputMs });
    if (this.samples.length > 1000) this.samples.splice(0, this.samples.length - 1000);
  }
  evaluate({ windows, capacities, revision, enabledModels }) {
    const now = this.now();
    if (now - this.lastCheck < 30000) return;
    this.lastCheck = now;
    if (this.revision && this.revision !== revision) this.changes.push({ at: now, previous: this.revision, revision });
    this.revision = revision; this.changes = this.changes.slice(-20);
    const checks = [];
    for (const w of windows) {
      const c = w.current, b = w.baseline, count = c.success + c.failed;
      checks.push({ id: `errors:${w.key}`, type: 'errors', model: w.context.model, context: w.context, evidence: w,
        usable: count >= 20, bad: count >= 20 && c.failed / count >= 0.1 });
      checks.push({ id: `slow:${w.key}`, type: 'slow', model: w.context.model, context: w.context, evidence: w,
        usable: c.validCount >= 20 && b.validCount >= 20,
        bad: c.p50Ms >= b.p50Ms * 2 && c.p50Ms - b.p50Ms >= 1000 });
    }
    for (const c of capacities) checks.push({ id: `capacity:${c.model}`, type: 'capacity', model: c.model,
      evidence: c, usable: c.capacity != null, bad: c.utilization >= 0.9 });
    const seen = new Set();
    for (const check of checks) {
      seen.add(check.id);
      const event = this.events.find(e => e.id === check.id && e.status === 'active');
      if (!enabledModels.includes(check.model)) { this.pending.delete(check.id); continue; }
      if (!check.usable) { this.pending.delete(check.id); if (event) event.awaitingData = true; continue; }
      const direction = check.bad ? 'bad' : 'good', prev = this.pending.get(check.id);
      this.pending.set(check.id, { direction, at: prev?.direction === direction ? prev.at : now });
      const confirmed = prev?.direction === direction && now - prev.at >= 30000;
      if (event) {
        event.awaitingData = false; event.lastCheckedAt = now; event.latestEvidence = check.evidence;
        if (!check.bad && confirmed) { event.status = 'resolved'; event.closedAt = now; event.resolution = 'observed_recovery'; }
      } else if (check.bad && confirmed) {
        const refs = this.samples.filter(s => s.at >= now - 6 * 60000 && s.model === check.model && (!check.context || ['scope', 'inference', 'stream', 'reasoning', 'inputBand', 'outputBand'].every(k => s[k] === check.context[k]))).slice(-5);
        this.events.push({ id: check.id, type: check.type, model: check.model, status: 'active', openedAt: now,
          lastCheckedAt: now, triggerEvidence: check.evidence, latestEvidence: check.evidence, samples: refs,
          configChanges: this.changes.filter(c => c.at >= now - 30 * 60000), awaitingData: false });
      }
    }
    for (const event of this.events) if (event.status === 'active') {
      if (!enabledModels.includes(event.model)) { event.status = 'closed'; event.closedAt = now; event.resolution = 'model_disabled_or_removed'; }
      else if (!seen.has(event.id)) event.awaitingData = true;
    }
    for (const id of this.pending.keys()) if (!seen.has(id)) this.pending.delete(id);
    this.samples = this.samples.filter(s => s.at >= now - 30 * 60000);
    this.events = this.events.filter(e => e.status === 'active' || e.closedAt >= now - RETENTION).slice(-200);
  }
  snapshot() {
    return { at: this.now(), lastCheckedAt: this.lastCheck, retentionDays: 14, maxEvents: 200,
      storageErrors: this.storageErrors, active: this.events.filter(e => e.status === 'active'),
      history: this.events.filter(e => e.status !== 'active').slice(-30).reverse(), configChanges: this.changes,
      thresholds: { consecutiveChecks: 2, checkIntervalMs: 30000, minAttempts: 20, failureRate: 0.1, latencyRatio: 2, latencyIncreaseMs: 1000, capacityUtilization: 0.9 } };
  }
  async flush() {
    if (!this.path) return;
    if (this.writing) await this.writing;
    const save = async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path + '.tmp', JSON.stringify({ version: 1, events: this.events, changes: this.changes, revision: this.revision }), { mode: 0o600 });
        await rename(this.path + '.tmp', this.path);
      } catch { this.storageErrors++; }
    };
    this.writing = save(); await this.writing; this.writing = null;
  }
}

export function qualityEvidence(models, manifest) {
  return { generatedAt: manifest.generatedAt, limitations: manifest.limitations, models: models.map(m => ({ model: m.id,
    scores: [...Object.entries(m.quality || {}), ...Object.entries(m.benchmarkScores?.subtasks || {}).map(([task, score]) => ['subtask:' + task, score.avg])].map(([task, value]) => {
      const evidence = manifest.models?.[m.id]?.[task];
      const source = task.startsWith('subtask:') ? m.benchmarkScores?.subtasksMeta?.source || '未登记' : m.qualitySource?.[task] || m.qualitySource?.default || '未登记';
      return { task, value, source, evidence: evidence || null,
        status: !evidence ? 'missing' : evidence.duplicateCount || evidence.validCount !== evidence.count ? 'invalid_evidence' : evidence.configSource !== source || Math.abs(evidence.mean - value) > 0.001 ? 'amended_or_mismatch' : 'historical_judge',
        missing: ['模型版本与推理参数', '题目内容版本', '业务任务成功标注'] };
    }) })) };
}

export function comparisonReadiness(recent) {
  return { scope: '本进程最近至多 2000 次决策', observations: recent.length,
    taskSuccessLabels: recent.filter(r => typeof r.taskSuccess === 'boolean').length,
    readyForControlledTrial: false,
    blockers: ['待提供代表业务任务及成功标准', '需冻结独立任务组与 train / validation / test 划分', '需同一任务的完整候选观测、固定模型版本与推理参数', '需记录含失败重试的实际任务总成本与端到端耗时'],
    protocol: '/docs/routing-matrix.md', plan: '/docs/controlled-comparison.md',
    note: 'HTTP 成功、历史 Judge 分数及仅被选模型的生产记录均不能替代业务成功标注或反事实对照。' };
}
