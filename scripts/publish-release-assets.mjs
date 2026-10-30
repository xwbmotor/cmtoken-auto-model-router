// Immutable release attachments. No asset deletion, replacement or --clobber.
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, open, unlink, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const execute = promisify(execFile);
export async function resolveRelease(find, create, pause = ms => new Promise(r => setTimeout(r, ms))) {
  let rows = await find();
  if (!rows.length) {
    if (create) try { await create(); } catch { /* reconcile once, never blindly recreate */ }
    for (const delay of [0, 200, 500, 1000, 2000, 4000]) {
      if (delay) await pause(delay);
      rows = await find();
      if (rows.length) break;
    }
  }
  if (rows.length !== 1) throw new Error('Expected exactly one existing release, including drafts');
  return rows[0];
}
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return 'sha256:' + hash.digest('hex');
}
export async function publishAssets(files, api) {
  if (!files.length || new Set(files.map(f => f.name)).size !== files.length) throw new Error('Empty or duplicate attachment list');
  const compare = async (file, asset) => {
    if (asset.state !== 'uploaded' || asset.size !== file.size || await api.digest(asset) !== file.digest)
      throw new Error(`Release attachment differs: ${file.name}; publish a new version, never replace it`);
  };
  const find = (assets, name) => {
    const matches = assets.filter(a => a.name === name);
    if (matches.length > 1) throw new Error(`Duplicate remote attachment: ${name}`);
    return matches[0];
  };
  const assets = await api.list();
  // Check the complete batch before uploading any missing member.
  for (const file of files) {
    const asset = find(assets, file.name);
    if (asset) await compare(file, asset);
  }
  const result = [];
  for (const file of files) {
    const existing = find(assets, file.name);
    if (existing) { result.push({ name: file.name, action: 'reused', digest: file.digest }); continue; }
    // Another publisher may win this race. Read fresh state even after an error;
    // do not retry an uncertain upload or delete an existing asset.
    try { await api.upload(file); } catch { /* reconcile below */ }
    const actual = find(await api.list(), file.name);
    if (!actual) throw new Error(`Upload not confirmed: ${file.name}`);
    await compare(file, actual);
    result.push({ name: file.name, action: 'verified', digest: file.digest });
  }
  return result;
}
export async function releaseApi(repo, tag, { create = false, commit } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^(v\d+\.\d+\.\d+|ci-evidence-\d{4}-\d{2})$/.test(tag || '')) throw new Error('Invalid release identity');
  const gh = async args => {
    try { return (await execute('gh', args, { maxBuffer: 16 * 1024 * 1024 })).stdout; }
    catch { throw new Error('GitHub request failed; no existing attachment was replaced'); }
  };
  const paged = async path => {
    const all = [];
    for (let page = 1; ; page++) {
      const rows = JSON.parse(await gh(['api', `${path}?per_page=100&page=${page}`]));
      if (!Array.isArray(rows)) throw new Error('Unexpected GitHub list response');
      all.push(...rows); if (rows.length < 100) return all;
    }
  };
  const find = async () => (await paged(`repos/${repo}/releases`)).filter(r => r.tag_name === tag);
  const createOnce = create ? async () => {
    if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Missing archive source commit');
    const flags = tag.startsWith('ci-evidence-') ? ['--prerelease','--latest=false'] : ['--verify-tag','--draft'];
    await gh(['release','create',tag,'--repo',repo,'--target',commit,...flags,'--title',tag,'--notes',tag.startsWith('ci-evidence-') ? 'CI verification evidence only. Not an application release. Each attachment records its source commit and workflow run.' : 'Release verification evidence. Deployment status is recorded separately.']);
  } : null;
  const release = await resolveRelease(find, createOnce);
  const list = () => paged(`repos/${repo}/releases/${release.id}/assets`);
  const digest = async asset => {
    if (asset.digest != null) {
      if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Unsupported remote checksum');
      return asset.digest;
    }
    // Older attachments may not have a server-provided digest. Stream to a
    // private temporary file and calculate it; never trust the filename alone.
    const folder = await mkdtemp(join(tmpdir(), 'amr-asset-check-')), path = join(folder, 'asset');
    const file = await open(path, 'wx', 0o600);
    try {
      await new Promise((ok, fail) => {
        const child = spawn('gh', ['api', `repos/${repo}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { stdio: ['ignore', file.fd, 'ignore'] });
        child.once('error', fail); child.once('close', code => code === 0 ? ok() : fail(new Error('Cannot verify existing attachment')));
      });
      await file.close(); return await sha256(path);
    } finally { await file.close().catch(() => {}); await unlink(path); await rmdir(folder); }
  };
  const upload = async file => {
    if (await sha256(file.path) !== file.digest) throw new Error('Local attachment changed');
    await gh(['release','upload',tag,file.path,'--repo',repo]);
  };
  return { list, digest, upload };
}async function main() {
  const [tag, directory, kind] = process.argv.slice(2), repo = process.env.GITHUB_REPOSITORY;
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || !['images','installer'].includes(kind)) throw new Error('Usage: node publish-release-assets.mjs vX.Y.Z DIRECTORY images|installer');
  const version = tag.slice(1), expected = kind === 'images'
    ? ['cmt-auto-model-router','cmt-amr-classifier','cmt-amr-go'].flatMap(n => [`${n}-${version}.tar.gz`,`${n}-${version}.tar.gz.sha256`]).concat('image-inspect.json')
    : [`amr-offline-${version}.tar.gz`,`amr-offline-${version}.tar.gz.sha256`];
  const files = [];
  for (const name of expected) {
    const path = resolve(directory, name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Invalid local attachment: ${name}`);
    files.push({ name, path, size: stat.size, digest: await sha256(path) });
  }
  console.log(JSON.stringify(await publishAssets(files, await releaseApi(repo, tag)), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
