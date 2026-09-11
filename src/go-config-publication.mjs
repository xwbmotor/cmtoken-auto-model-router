import { readFile } from 'node:fs/promises';
import { configPath, loadConfig, saveConfig, getConfigRevision } from './config.mjs';
import { atomicSnapshot, encodeSnapshot } from './go-runtime/snapshot.mjs';

// One queue covers both source persistence and Go publication. A failed Go
// validation restores the exact old source bytes only after the live generation
// is confirmed unchanged. Unknown outcomes block new traffic until reconciled.
export function createGoConfigPublication(admin, validate = () => {}) {
  let chain = Promise.resolve(), blocked = false;
  const queue = run => { const task = chain.then(run); chain = task.catch(() => {}); return task; };
  const failure = (message, code = 'core_publication_failed') => Object.assign(new Error(message), { code });
  async function publish(next, before) {
    const result = await admin.reload(before.revision);
    if (result.status !== 200 || result.configRevision !== getConfigRevision(next)) {
      throw failure('Go 配置发布未通过，当前请求链路未确认采用新配置。');
    }
    blocked = false;
    return next;
  }
  return {
    blocked: () => blocked,
    save: (next, options) => queue(async () => {
      validate(next);
      const previousRaw = await readFile(configPath());
      const previous = await loadConfig();
      if (Boolean(next.budget?.enabled) !== Boolean(previous.budget?.enabled)) {
        throw failure('Go 账本保护模式变更需要受控重启和独立账本，本次配置未保存。', 'core_storage_mode_change');
      }
      encodeSnapshot(next); // Resolve and validate snapshot before source mutation.
      const before = await admin.status();
      if (before.status !== 200 || before.publicationPending || before.configRevision !== getConfigRevision(previous)) {
        blocked = true;
        throw failure('Go 与当前磁盘配置不一致，请先重新加载配置完成同步。', 'core_publication_pending');
      }
      const saved = await saveConfig(next, options);
      blocked = true;
      try { return await publish(saved, before); }
      catch (error) {
        let state;
        try { state = await admin.status(); } catch { /* keep blocked */ }
        if (state?.status === 200 && state.configRevision === getConfigRevision(saved) && !state.publicationPending) {
          blocked = false; return saved;
        }
        if (state?.status === 200 && state.revision === before.revision && !state.publicationPending) {
          const current = await loadConfig();
          if (getConfigRevision(current) === getConfigRevision(saved)) {
            await atomicSnapshot(configPath(), previousRaw);
            blocked = false;
            throw failure('Go 拒绝新配置，已恢复原配置，请修改后重新发布。');
          }
        }
        throw failure('配置已保存，但 Go 发布结果尚未确认；请求已暂停，请重新加载配置完成同步。', 'core_publication_pending');
      }
    }),
    reload: () => queue(async () => {
      blocked = true;
      const next = await loadConfig();
      validate(next);
      encodeSnapshot(next);
      const before = await admin.status();
      if (before.status !== 200) throw failure('Go 控制服务不可用。', 'core_publication_pending');
      return publish(next, before);
    })
  };
}
