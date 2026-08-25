// Judge 上游通道秘密存储：管理端可配 judge 端点+key，独立落 data/judge-secret.json。
// 安全边界（与 config/judge 分离的原因）：
// 1. key 永不进 config/router.json——GET /admin/api/config 永远带不出 key；
// 2. GET 只回 masked 视图（apiKeySet + 末4位预览），不回明文；
// 3. 原子写（tmp+rename），损坏文件容错返回 null（judge 退化 skipped:no_api_key，不影响业务）。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export class JudgeSecretStore {
  constructor({ path } = {}) {
    this.path = path;
  }
  get() {
    try {
      if (!existsSync(this.path)) return null;
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : null;
      const apiKey = typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : null;
      if (!baseUrl || !apiKey) return null;
      return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey };
    } catch { return null; } // 损坏/截断 → 无 secret，judge 走 skipped 不炸
  }
  save({ baseUrl, apiKey }) {
    if (!baseUrl || !apiKey) throw new Error('judge secret 需要 baseUrl 与 apiKey');
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ baseUrl: baseUrl.replace(/\/$/, ''), apiKey }, null, 2), { mode: 0o600 }); // 
    renameSync(tmp, this.path);
  }
  clear() {
    try { if (existsSync(this.path)) unlinkSync(this.path); } catch { /* 清除失败不阻断 */ }
  }
  // 管理端视图：只暴露是否存在与末 4 位
  masked() {
    const cur = this.get();
    if (!cur) return { apiKeySet: false, baseUrl: null, apiKeyPreview: null };
    return { apiKeySet: true, baseUrl: cur.baseUrl, apiKeyPreview: `…${cur.apiKey.slice(-4)}` };
  }
}
