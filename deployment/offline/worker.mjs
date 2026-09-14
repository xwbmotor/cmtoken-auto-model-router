import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '/app/src/config.mjs';
import { encodeSnapshot, atomicSnapshot } from '/app/src/go-runtime/snapshot.mjs';

const action = process.argv[2];
const root = process.env.AMR_INSTALL_ROOT;
const release = JSON.parse(await fs.readFile('/bundle/release.json', 'utf8'));
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const escape = value => typeof value === 'string' ? value.replaceAll('$', '$$') : Array.isArray(value) ? value.map(escape) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,escape(v)])) : value;

async function state() {
  const s = JSON.parse(await fs.readFile('/installed/installation.json', 'utf8'));
  assert(s.root === root, '安装目录发生变化，请先检查挂载路径。');
  assert(s.version === release.version && s.revision === release.revision, '安装记录与镜像发布版本不一致。');
  assert(/^[a-z][a-z0-9-]{0,39}$/.test(s.project), '安装项目名无效。');
  return s;
}

async function prepare() {
  const project = process.env.AMR_INSTALL_PROJECT;
  const bind = process.env.AMR_INSTALL_BIND;
  const port = Number(process.env.AMR_INSTALL_PORT);
  assert(/^[a-z][a-z0-9-]{0,39}$/.test(project), '项目名只允许小写字母、数字和连字符。');
  const { isIP } = await import('node:net');
  assert(isIP(bind) && Number.isInteger(port) && port > 0 && port < 65536, '监听 IP 或端口无效。');
  const cfg = JSON.parse(await fs.readFile('/output/input.json', 'utf8'));
  assert(cfg.budget?.enabled === false, '当前镜像安装要求 budget.enabled=false。');
  const upstream = new URL(cfg.upstreamBaseUrl);
  assert(upstream.protocol === 'https:' && !upstream.username && !upstream.password && !upstream.search && !upstream.hash && !upstream.hostname.endsWith('.invalid'), '请提供有效的 HTTPS 中台基础地址。');
  assert(cfg.models?.length && cfg.models.every(m => m.id !== 'replace-with-your-model'), '请使用已配置的模型，不能使用占位模型 ID。');
  const secrets = [];
  function check(value, at = 'config') {
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      if (/^(api_?key|token|secret|password|adminToken|accessKey|authorization)$/i.test(key) && v) secrets.push(at + '.' + key);
      else check(v, at + '.' + key);
    }
  }
  check(cfg);
  assert(!secrets.length, '业务配置含凭证字段，请移除凭证后再初始化。');
  cfg.version = release.version;
  cfg.upstreamBaseUrl = upstream.href.replace(/\/$/, '');
  if (cfg.semanticRouter?.httpJson) cfg.semanticRouter.httpJson.url = 'http://127.0.0.1:8788/classify';
  const t = Object.fromEntries(['admin','metrics','bucket','edge','goAdmin'].map(k => [k,crypto.randomBytes(48).toString('base64url')]));
  for (const dir of ['config','data','data/go-native-' + release.version]) await fs.mkdir('/output/' + dir, { mode: 0o750 });
  await write('/output/config/router.json', cfg);
  await write('/output/config/go-auth.json', {mode: 'passthrough', adminToken: t.goAdmin});
  process.env.CONFIG_PATH = '/output/config/router.json';
  await atomicSnapshot('/output/config/go-runtime.json', encodeSnapshot(await loadConfig()).data);
  const compose = JSON.parse(await fs.readFile('/bundle/compose.template.json', 'utf8'));
  compose.name = project;
  const node = compose.services['auto-model-router'], go = compose.services['go-core'];
  for (const [role, svc] of Object.entries(compose.services)) {
    svc.container_name = project + '-' + ({'auto-model-router':'node','go-core':'go','classifier':'classifier'}[role]);
    for (const mount of svc.volumes || []) mount.source = root + mount.source.slice('/opt/amr'.length);
  }
  Object.assign(node.environment, {ADMIN_TOKEN:t.admin, METRICS_TOKEN:t.metrics, SEMANTIC_BUCKET_SECRET:t.bucket,
    AMR_GO_EDGE_TOKEN:t.edge, AMR_GO_ADMIN_TOKEN:t.goAdmin, MAAS_BASE_URL:cfg.upstreamBaseUrl});
  Object.assign(go.environment, {AMR_GO_EDGE_TOKEN:t.edge, AMR_GO_SEMANTIC_BUCKET_SECRET:t.bucket, AMR_GO_SEMANTIC_SMALL_TOKEN:''});
  go.command[go.command.indexOf('--upstream')+1] = cfg.upstreamBaseUrl + '/chat/completions';
  go.command[go.command.indexOf('--scope-url')+1] = cfg.upstreamBaseUrl + '/models';
  go.command[go.command.indexOf('--semantic-large')+1] = cfg.upstreamBaseUrl + '/chat/completions';
  Object.assign(compose.services.classifier.ports[0], {host_ip:bind, published:String(port)});
  if (process.env.AMR_INSTALL_CA === '1') {
    await fs.copyFile('/output/ca-input.pem','/output/config/upstream-ca.pem');
    await fs.chmod('/output/config/upstream-ca.pem',0o600);
    node.environment.NODE_EXTRA_CA_CERTS = '/app/config/upstream-ca.pem';
    go.environment.SSL_CERT_FILE = '/app/config/upstream-ca.pem';
  }
  await write('/output/credentials.json', {ADMIN_TOKEN:t.admin, METRICS_TOKEN:t.metrics});
  await write('/output/compose.json', escape(compose));
  await write('/output/installation.json', {root, project, bind, port, version:release.version, revision:release.revision, installer:'offline-shell-v1'});
  await fs.unlink('/output/input.json');
  if (process.env.AMR_INSTALL_CA === '1') await fs.unlink('/output/ca-input.pem');
  return {prepared:true, modelCount:cfg.models.length, judgeEnabled:cfg.judge?.enabled === true,
    notice:'未复制现网凭证。Judge 等独立评审凭证需在新环境另行配置。'};
}

async function health() {
  await state();
  const rows = (await fs.readFile('/inspection/containers.jsonl','utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert(rows.length === 3 && new Set(rows.map(x => x.service)).size === 3, '应有三个服务。');
  const names = {'auto-model-router':'cmt-auto-model-router', classifier:'cmt-amr-classifier', 'go-core':'cmt-amr-go'};
  for (const row of rows) {
    assert(release.images[names[row.service]]?.ids.includes(row.image), '运行镜像与发布记录不一致。');
    assert(row.status === 'running' && row.health === 'healthy', '服务尚未全部健康，请在服务器本地查看日志。');
  }
  return {healthy:true,services:rows.map(x=>({service:x.service,health:x.health})),businessRequestsVerified:false};
}

async function verify() {
  const s = await state();
  let host = s.bind === '0.0.0.0' ? '127.0.0.1' : s.bind === '::' ? '::1' : s.bind;
  if (host.includes(':')) host = '[' + host + ']';
  const base = `http://${host}:${s.port}`;
  const key = (await fs.readFile('/run/business.key','utf8')).trim();
  assert(key && !/[\r\n]/.test(key),'业务 key 文件格式不正确。');
  const requests = [];
  for (const stream of [false,true]) {
    const requestId = 'offline-install-' + crypto.randomUUID();
    const res = await fetch(base + '/v1/chat/completions', {method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','X-Request-ID':requestId},
      body:JSON.stringify({messages:[{role:'user',content:'Reply with the number 42.'}],max_tokens:128,stream}),signal:AbortSignal.timeout(90000)});
    assert(res.status === 200, '业务调用未成功，请检查调用方权限、网络和模型配置。');
    const raw = await res.text();
    if (stream) {
      assert(raw.trimEnd().endsWith('data: [DONE]') && raw.split('data: [DONE]').length === 2, 'SSE 未完整结束。');
      const events = raw.split('\n').filter(x=>x.startsWith('data: ') && x.trim()!=='data: [DONE]').map(x=>JSON.parse(x.slice(6)));
      assert(events.some(e=>e.choices?.some(c=>c.delta?.content)), 'SSE 没有正文。');
    } else assert(JSON.parse(raw).choices?.some(c=>c.message?.content),'JSON 没有正文。');
    requests.push({requestId,stream,complete:true});
  }
  const ids = new Set(requests.map(x=>x.requestId));
  let found = false;
  for(let i=0;i<40;i++) {
    const counts = Object.fromEntries([...ids].map(id=>[id,0]));
    const names = (await fs.readdir('/installed/data/decisions')).filter(x=>/^decisions-.*\.jsonl$/.test(x)).sort().slice(-3);
    for (const name of names) {
      const { createReadStream } = await import('node:fs');
      const { createInterface } = await import('node:readline');
      for await (const line of createInterface({input:createReadStream('/installed/data/decisions/'+name),crlfDelay:Infinity})) {
        let row;try {row=JSON.parse(line);} catch {continue;}
        const id=row.request?.requestId;if(ids.has(id)) counts[id]++;
      }
    }
    if(Object.values(counts).every(x=>x===1)) {found=true;break;}
    await new Promise(r=>setTimeout(r,500));
  }
  assert(found,'决策记录缺失或重复，请检查服务本地日志。');
  return {passed:true,requests,decisionRecordsExactlyOnce:true,modelQualityVerified:false,backgroundReviewsVerified:false};
}

try {
  let result;
  if(action==='prepare') result=await prepare();
  else if(action==='project') {console.log((await state()).project);process.exit(0);}
  else if(action==='check') result=await health();
  else if(action==='verify') result=await verify();
  else throw new Error('Unknown action');
  console.log(JSON.stringify(result));
} catch(e) {
  // No config values, server responses, key or stack traces in installer output.
  console.error('安装步骤失败：'+ (e instanceof SyntaxError ? '配置或返回数据格式无效。' : String(e.message).replace(/https?:\/\/\S+/g,'[endpoint]')));
  process.exit(1);
}
