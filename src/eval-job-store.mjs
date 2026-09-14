import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const LIMIT_BYTES = 32 * 1024 * 1024;
const MAX_JOBS = 32;
const FINISHED = new Set(['done', 'failed', 'cancelled', 'interrupted']);

export class EvalJobStore {
  constructor(path, retentionMs = 2 * 3600000) {
    this.path = path; this.retentionMs = retentionMs; this.jobs = new Map(); this.pending = Promise.resolve();
  }
  static async load(path, retentionMs) {
    const store = new EvalJobStore(path, retentionMs);
    let raw;
    try { const info = await lstat(path); if (!info.isFile() || info.size > LIMIT_BYTES) throw new Error('评测任务文件无效或超过容量限制'); raw = await readFile(path); } catch (error) { if (error.code === 'ENOENT') return store; throw error; }
    if (raw.length > LIMIT_BYTES) throw new Error('评测任务文件超过容量限制');
    const data = JSON.parse(raw.toString('utf8'));
    if (data.version !== 1 || !Array.isArray(data.jobs) || data.jobs.length > MAX_JOBS) throw new Error('评测任务文件格式无效');
    for (const job of data.jobs) {
      if (!job || typeof job.id !== 'string' || !/^job_[a-zA-Z0-9_-]{1,80}$/.test(job.id) || store.jobs.has(job.id) ||
          !['checkup', 'full', 'interleaved'].includes(job.type) || !Number.isFinite(Date.parse(job.startedAt)) ||
          (job.finishedAt && !Number.isFinite(Date.parse(job.finishedAt))) || !Array.isArray(job.results) || !Number.isInteger(job.done) || job.done < 0 ||
          ![...FINISHED, 'running', 'queued'].includes(job.status)) throw new Error('评测任务记录无效');
      if (!FINISHED.has(job.status)) {
        job.status = 'interrupted'; job.finishedAt = new Date().toISOString(); job.cancelRequested = true;
        job.error = '服务重启，任务已中断。已保存部分结果，不会自动重新调用模型。';
      }
      store.jobs.set(job.id, job);
    }
    store.sweep(); await store.save(); return store;
  }
  sweep(now = Date.now()) {
    for (const [id, job] of this.jobs) if (job.finishedAt && now - Date.parse(job.finishedAt) > this.retentionMs) this.jobs.delete(id);
  }
  async add(job) {
    this.sweep();
    if (this.jobs.size >= MAX_JOBS) {
      const finished = [...this.jobs.values()].filter(j => j.finishedAt).sort((a,b) => Date.parse(a.finishedAt)-Date.parse(b.finishedAt));
      if (!finished.length) throw new Error('评测任务数量已达上限');
      this.jobs.delete(finished[0].id);
    }
    if (this.jobs.has(job.id)) throw new Error('评测任务 ID 重复');
    this.jobs.set(job.id, job);
    try { await this.save(); } catch (error) { this.jobs.delete(job.id); throw error; }
  }
  save() {
    const snapshot = JSON.stringify({version: 1, jobs: [...this.jobs.values()]}) + '\n';
    if (Buffer.byteLength(snapshot) > LIMIT_BYTES) return Promise.reject(new Error('评测任务结果超过存储上限，已停止继续评测'));
    const task = this.pending.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
      const temp = this.path + '.' + randomUUID() + '.tmp';
      let file;
      try {
        file = await open(temp, 'wx', 0o600); await file.writeFile(snapshot); await file.sync(); await file.close(); file = null;
        await rename(temp, this.path);
        if (process.platform !== 'win32') {
          const dir = await open(dirname(this.path), 'r'); try { await dir.sync(); } finally { await dir.close(); }
        }
      } finally { await file?.close(); await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    });
    this.pending = task; return task;
  }
}
