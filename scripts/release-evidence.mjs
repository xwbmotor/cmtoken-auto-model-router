import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function summarizeRelease(report, expectedTag, expectedCommit) {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  check(/^v\d+\.\d+\.\d+$/.test(expectedTag), 'Invalid release tag');
  check(/^[a-f0-9]{40}$/.test(expectedCommit), 'Invalid source commit');
  check(report.git?.tag === expectedTag && report.git?.commit === expectedCommit && `v${report.version}` === expectedTag, 'Release identity mismatch');
  const s = report.summary;
  check(report.validForRelease === true && report.allowDirty === false && report.exitCode === 0 && report.signal == null && report.git.dirty?.length === 0, 'Not a successful formal release');
  check(s && ['tests','pass','fail','skipped','cancelled'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0) && s.tests > 0 && s.pass === s.tests && s.fail + s.skipped + s.cancelled === 0, 'Incomplete test results');
  check(report.gate && Object.values(report.gate).every(v => v === true), 'Release gate failed');
  const images = {};
  for (const name of ['router','classifier','go']) {
    const id = report.images?.[`${name}ImageId`], revision = report.images?.[`${name}LabelsRevision`];
    if (name === 'go' && id == null) continue;
    check(/^sha256:[a-f0-9]{64}$/.test(id) && revision === expectedCommit, 'Image identity mismatch');
    images[name] = { id, revision };
  }
  check(Number.isFinite(Date.parse(report.stamp)), 'Missing verification time');
  // Deliberate allowlist: never archive hostnames, environment, raw logs or configuration.
  return { schemaVersion: 1, tag: expectedTag, commit: expectedCommit, verifiedAt: report.stamp,
    checks: { tests: s.tests, passed: s.pass, failed: s.fail, skipped: s.skipped, cancelled: s.cancelled }, images,
    scope: 'formal-release-tests-and-image-identity', deploymentVerified: false };
}

async function main() {
  const [tag, commit, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/release-evidence.mjs TAG COMMIT OUTPUT');
  const files = (await readdir('reports')).filter(n => n.startsWith(`release-${tag}-`) && n.endsWith('.json')).sort();
  if (!files.length) throw new Error('No release report');
  const bytes = await readFile(join('reports', files.at(-1)));
  const summary = summarizeRelease(JSON.parse(bytes), tag, commit);
  summary.sourceReportSha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(output, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
