// v0.9.2 Judge 上游通道管理端可配（端点+key 落 data/judge-secret.json；key 不可见/不可导出/不入 config/git）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('judgeSecret：save/load/轮换/清除，key 永不入 config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-js-'));
  try {
    const { JudgeSecretStore } = await import('../src/judge-secret.mjs');
    const store = new JudgeSecretStore({ path: join(dir, 'judge-secret.json') });
    assert.equal(store.get(), null, '初始无 key');
    store.save({ baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk-test-1234567890' });
    const loaded = store.get();
    assert.equal(loaded.baseUrl, 'https://api.z.ai/api/coding/paas/v4');
    assert.equal(loaded.apiKey, 'sk-test-1234567890');
    // 文件在磁盘上（git-ignored 目录内）
    assert.ok(existsSync(join(dir, 'judge-secret.json')));
    // 轮换
    store.save({ baseUrl: 'https://maas.example/v1', apiKey: 'sk-new-9876543210' });
    assert.equal(store.get().apiKey, 'sk-new-9876543210');
    // 清除
    store.clear();
    assert.equal(store.get(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('judgeSecret：损坏文件容错（返回 null 不炸进程）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-js2-'));
  try {
    writeFileSync(join(dir, 'judge-secret.json'), '{truncated...');
    const { JudgeSecretStore } = await import('../src/judge-secret.mjs');
    const store = new JudgeSecretStore({ path: join(dir, 'judge-secret.json') });
    assert.equal(store.get(), null, '损坏 JSON 返回 null');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('judgeSecret：masked 视图只回 baseUrl+末4位，不回完整 key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amr-js3-'));
  try {
    const { JudgeSecretStore } = await import('../src/judge-secret.mjs');
    const store = new JudgeSecretStore({ path: join(dir, 'judge-secret.json') });
    store.save({ baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk-abcdef1234XYZW' });
    const m = store.masked();
    assert.equal(m.apiKeySet, true);
    assert.equal(m.apiKeyPreview, '…XYZW');
    assert.equal(JSON.stringify(m).includes('sk-abcdef1234XYZW'), false, 'masked 不得含完整 key');
    store.clear();
    const m2 = store.masked();
    assert.equal(m2.apiKeySet, false);
    assert.equal(m2.apiKeyPreview, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
