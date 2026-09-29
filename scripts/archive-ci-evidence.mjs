import { glob, lstat, realpath, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { publishAssets, releaseApi, sha256 } from './publish-release-assets.mjs';
const exec = promisify(execFile);

export function archiveIdentity(env, now = new Date()) {
  for (const key of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT']) if (!/^\d+$/.test(env[key] || '')) throw new Error(`Missing ${key}`);
  if (!/^[a-zA-Z0-9_-]+$/.test(env.EVIDENCE_LABEL || '') || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('Invalid evidence identity');
  const formal = env.EVIDENCE_RELEASE_TAG || '';
  if (formal && !/^v\d+\.\d+\.\d+$/.test(formal)) throw new Error('Invalid formal release tag');
  return { tag: formal || `ci-evidence-${now.toISOString().slice(0,7)}`,
    name: `${env.EVIDENCE_LABEL}-${env.GITHUB_SHA.slice(0,12)}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` };
}
export async function collectEvidence(root, patterns) {
  root = await realpath(root); const paths = new Set();
  for (const pattern of patterns) {
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) throw new Error('Evidence pattern escapes workspace');
    for await (const name of glob(pattern, { cwd: root })) {
      const path = resolve(root, name), info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Evidence symlink refused');
      if (info.isDirectory()) {
        for (const file of await collectEvidence(root, [name.replaceAll('\\','/')+'/**/*'])) paths.add(file);
      } else if (info.isFile()) {
        const actual = await realpath(path), rel = relative(root, actual);
        if (rel === '..' || rel.startsWith('..'+sep) || isAbsolute(rel)) throw new Error('Evidence file escapes workspace');
        if (/(^|[\\/])(\.env(?:\..*)?|credentials\.json|go-auth\.json|auth\.json|id_rsa|id_ed25519)$/i.test(rel)) throw new Error('Credential file refused');
        paths.add(rel.replaceAll('\\','/'));
      }
    }
  }
  return [...paths].sort();
}
async function main() {
  const env = process.env;
  if (env.GITHUB_EVENT_NAME === 'pull_request' || env.GITHUB_EVENT_NAME === 'pull_request_target') throw new Error('PR jobs must not publish release evidence');
  const sourceCommit = (await exec('git',['rev-parse','HEAD'])).stdout.trim();
  const identity = archiveIdentity({...env,GITHUB_SHA:sourceCommit}), root = process.cwd(), paths = await collectEvidence(root, (env.EVIDENCE_PATHS || '').split(/\r?\n/).filter(Boolean));
  if (!paths.length && env.EVIDENCE_JOB_STATUS === 'success') throw new Error('Successful job produced no required evidence');
  const folder = join(env.RUNNER_TEMP, identity.name); await mkdir(folder, { recursive: false });
  const manifest = { schemaVersion:1, sourceCommit, workflowCommit:env.GITHUB_SHA, runId:env.GITHUB_RUN_ID, attempt:env.GITHUB_RUN_ATTEMPT,
    job:env.GITHUB_JOB, testStatus:env.EVIDENCE_JOB_STATUS, missingEvidence:paths.length===0,
    runUrl:`https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, files:[] };
  for (const path of paths) manifest.files.push({path,sha256:await sha256(resolve(root,path)),bytes:(await lstat(resolve(root,path))).size});
  const manifestFile=join(folder,'manifest.json');await writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');
  const fileList=join(folder,'files.list');await writeFile(fileList,paths.map(p=>p+'\0').join(''));
  const archive=join(folder,identity.name+'.tar.gz');
  await exec('tar',['-czf',archive,'-C',folder,'manifest.json','-C',root,'--null','-T',fileList]);
  // Recheck inputs before publication; no changing or silently redacting evidence.
  for (const file of manifest.files) if (await sha256(resolve(root,file.path))!==file.sha256) throw new Error('Evidence changed during packaging');
  const digest=await sha256(archive), checksum=archive+'.sha256';await writeFile(checksum,`${digest.slice(7)}  ${identity.name}.tar.gz\n`);
  const files=[];
  for (const path of [archive,checksum]) files.push({path,name:path.split(/[\\/]/).at(-1),size:(await lstat(path)).size,digest:await sha256(path)});
  await publishAssets(files,await releaseApi(env.GITHUB_REPOSITORY,identity.tag,{create:true,commit:sourceCommit}));
  const url=`https://github.com/${env.GITHUB_REPOSITORY}/releases/tag/${identity.tag}`;
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,`\n### Verification evidence\n\nTest status before archival: **${env.EVIDENCE_JOB_STATUS}**. Source: \`${env.GITHUB_SHA}\`.\n\n[Verified archive](${url}) — \`${identity.name}.tar.gz\`\n\nSHA256: \`${digest.slice(7)}\`; files: ${paths.length}. Archival does not turn failed tests into success.\n`);
  console.log(JSON.stringify({archived:true,tag:identity.tag,name:identity.name,sha256:digest,fileCount:paths.length,testStatus:env.EVIDENCE_JOB_STATUS}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
