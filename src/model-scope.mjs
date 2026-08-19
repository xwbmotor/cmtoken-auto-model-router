// 客户端套餐动态候选池：OpenAI 规范的 GET /v1/models 返回该 key 实际可用的模型集合，
// auto 路由必须先按 key 解析可用集再做候选过滤——否则会把请求发给该租户无权调用的模型，
// 白白吃一次上游 403 再 fallback（时延+错误率双输）。
//
// 设计要点：
// - 按 key 缓存（不同套餐不同可用集），TTL 过期后台刷新（stale-while-revalidate）；
// - 失败回退全量（fail-open）：上游 /models 抖动不应阻断路由；
// - 交集为空也回退全量：防「上游模型命名与 router 配置不一致」导致候选全灭；
// - strict 模式（ROUTER_ACCESS_KEY）没有租户语义，恒回退全量。

const SCOPE_TTL_MS = Number(process.env.MODEL_SCOPE_TTL_MS || 60_000);
const SCOPE_TIMEOUT_MS = Number(process.env.MODEL_SCOPE_TIMEOUT_MS || 3000);

const cache = new Map(); // keyHash -> { at, ids: Set<string>|null }

function hashKey(authorizationHeader) {
  const raw = String(authorizationHeader || '').replace(/^Bearer\s+/i, '');
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) { h = (h * 31 + raw.charCodeAt(i)) | 0; }
  return `k${(h >>> 0).toString(36)}${raw.length}`;
}

function parseModelIds(payload) {
  if (!payload || !Array.isArray(payload.data)) return null;
  const ids = payload.data.map((m) => m && m.id).filter((id) => typeof id === 'string' && id);
  return ids.length ? new Set(ids) : null;
}

// 拉取某 key 的可用模型集；不可用/未配置/解析失败一律返回 null（= 用全量）
async function fetchScope(baseUrl, apiKey) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base || !apiKey) return null;
  try {
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(SCOPE_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    return parseModelIds(await res.json());
  } catch {
    return null; // 超时/网络错误：fail-open
  }
}

// 入口：返回该客户端 key 当前生效的可用模型 ID 集（null=不限制，用全量）
// 缓存策略：命中且未过期直接用；命中但过期先返回旧值（不阻塞请求）再后台刷新；从未拉过则同步拉一次
export async function resolveModelScope({ baseUrl, apiKey, authorizationHeader, passthrough }) {
  if (!passthrough) return null; // strict 模式：ROUTER_ACCESS_KEY 无租户语义
  if (!authorizationHeader) return null;
  const keyHash = hashKey(authorizationHeader);
  const now = Date.now();
  const hit = cache.get(keyHash);
  if (hit && now - hit.at < SCOPE_TTL_MS) return hit.ids;

  if (hit) {
    // stale-while-revalidate：先给旧值，后台刷新
    fetchScope(baseUrl, apiKey).then((ids) => { cache.set(keyHash, { at: Date.now(), ids }); }).catch(() => {});
    return hit.ids;
  }
  const ids = await fetchScope(baseUrl, apiKey);
  cache.set(keyHash, { at: now, ids });
  return ids;
}

// 候选过滤用：scope 为 null 或包含该模型 → 允许
export function scopeAllows(scope, modelId) {
  if (!scope) return true;
  return scope.has(modelId);
}

// scope 与 router 配置的启用模型的交集是否为空（空则上层应回退全量，防命名不匹配全灭）
export function scopeIntersectsConfig(scope, models) {
  if (!scope) return true;
  return models.some((m) => m.enabled !== false && scope.has(m.id));
}

// 管理页/测试观测用
export function scopeCacheStats() {
  return { entries: cache.size, ttlMs: SCOPE_TTL_MS };
}
