import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRateLimiter } from '../src/rate-limiter.mjs';
import { validateConfig, saveConfig } from '../src/config.mjs';
import { DecisionLog } from '../src/decision-log.mjs';

// ---------- rate-limiter：令牌桶 ----------
test('令牌桶：burst 内放行，超限返回 retryAfterMs，随时间 refill', () => {
  const rl = createRateLimiter({ rpm: 60, burst: 3 });  // 1 token/秒
  assert.equal(rl.check('k', 1000).allowed, true);
  assert.equal(rl.check('k', 1000).allowed, true);
  assert.equal(rl.check('k', 1000).allowed, true);
  const over = rl.check('k', 1000);
  assert.equal(over.allowed, false);
  assert.ok(over.retryAfterMs > 0);
  // 1 秒后 refill 1 token → 放行
  assert.equal(rl.check('k', 2000).allowed, true);
  // 不同 key 独立计数
  assert.equal(rl.check('other', 2000).allowed, true);
});

test('令牌桶：update 改变 rpm/burst', () => {
  const rl = createRateLimiter({ rpm: 60, burst: 1 });
  assert.equal(rl.check('k', 1000).allowed, true);
  assert.equal(rl.check('k', 1000).allowed, false);  // burst=1 用完
  rl.update({ rpm: 600, burst: 5 });  // 10 token/秒
  assert.equal(rl.check('k', 1100).allowed, true);  // 100ms refill 1 token
});

// ---------- config 校验：rateLimit + redactMessages ----------
test('validateConfig：rateLimit.rpm 非整数报错', () => {
  const cfg = validBase();
  cfg.rateLimit = { enabled: true, rpm: 1.5, burst: 10 };
  assert.throws(() => validateConfig(cfg), /rateLimit\.rpm/);
});

test('validateConfig：rateLimit.enabled 非布尔报错', () => {
  const cfg = validBase();
  cfg.rateLimit = { enabled: 'yes', rpm: 10, burst: 10 };
  assert.throws(() => validateConfig(cfg), /rateLimit\.enabled/);
});

test('validateConfig：decisionLog.redactMessages 非布尔报错', () => {
  const cfg = validBase();
  cfg.decisionLog = { enabled: true, dirPath: './x', redactMessages: 'false' };
  assert.throws(() => validateConfig(cfg), /redactMessages/);
});

test('validateConfig：合法 rateLimit 通过', () => {
  const cfg = validBase();
  cfg.rateLimit = { enabled: true, rpm: 120, burst: 120 };
  assert.doesNotThrow(() => validateConfig(cfg));
});

// ---------- saveConfig 并发串行化 ----------
test('saveConfig 并发串行化：version 为软件版本 + 无 temp 残留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const cfgPath = join(dir, 'router.json');
  process.env.CONFIG_PATH = cfgPath;
  try {
    writeFileSync(cfgPath, JSON.stringify(validBase()));
    // 并发 5 次保存：串行化保证无 temp 残留；version 统一为软件版本（semver），不再整数递增
    const results = await Promise.all(Array.from({ length: 5 }, () => saveConfig(validBase())));
    assert.ok(results.every((r) => typeof r.version === 'string' && /^\d+\.\d+\.\d+$/.test(r.version)));
    assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).version, results[0].version);
    assert.equal(readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CONFIG_PATH;
  }
});

// ---------- decision-log：diskUsage ----------
test('diskUsage：空目录返回 0，写入后返回非零字节', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dlog-'));
  const log = new DecisionLog({ enabled: true, dirPath: '.' });
  log.projectRoot = dir;
  try {
    const empty = await log.diskUsage();
    assert.equal(empty.bytes, 0);
    assert.equal(empty.files, 0);
    // 写一条日志
    log.currentFile = join(dir, 'decisions-2026-08-18.jsonl');
    log.currentBytes = 0;
    await log.append(log.entry({ model: 'auto', messages: [] }, { requestedModel: 'auto', suggestedModel: 'm', selectedModel: 'm' }, { ok: true }));
    const usage = await log.diskUsage();
    assert.ok(usage.bytes > 0);
    assert.equal(usage.files, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function validBase() {
  return {
    models: [{ id: 'm1', ownership: 'self_hosted', quality: { default: 0.8 } }],
    routing: {
      mode: 'shadow',
      qualityFloor: 0.5,
      qualityWeight: 1,
      costWeight: 0.2,
      latencyWeight: 0.1,
      selfHostedBonus: 0.1,
      activeTrafficPercent: 100,
      complexQualityMargin: 0.04,
      maxAttempts: 1,
      defaultExplicitModel: 'm1',
      shadowModel: 'm1'
    }
  };
}
