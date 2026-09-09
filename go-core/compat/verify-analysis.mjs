import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { analyzeRequest } from '../../src/router.mjs';
import { loadConfig } from '../../src/config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const flag = process.argv.indexOf('--binary');
const binary = resolve(process.argv[flag + 1] || `${root}/data/go-migration/amr-core.exe`);
const config = await loadConfig();
const cfg = { taskRules: config.taskRules, budget: { defaultEstimatedOutputTokens: config.budget.defaultEstimatedOutputTokens } };
const prompts = JSON.parse(readFileSync(`${root}/config/eval-gate.json`, 'utf8')).cases.map(c => c.prompt);
prompts.push('你好', '今天星期几？', '不要写代码', '不要解释，直接写函数', '什么是代码', '总结这段代码', '😀😀代码', 'hello\nworld', '金融行情', 'hi', 'hi中', 'HI😀', '部署架构，考虑成本、质量、时延，同时保证安全', '解析文件', '全库代码扫描');
for(const gap of ['😀','😀😀','😀😀😀','\r','\u2028','\u2029']) prompts.push(`解析${gap}文件`,`写${gap}故事`,`不要${gap}写代码`,`通俗${gap}解释代码`);
const rows = [];
for (const text of prompts) for (let mode = 0; mode < 12; mode++) {
  const body = { messages: [{ role: 'user', content: text }], stream: mode % 2 === 0 };
  if (mode === 1) body.messages.unshift({role:'system',content:'你是编程助手\n```python\n'});
  if (mode === 2) body.messages.unshift({role:'assistant',content:'代码'.repeat(800)});
  if (mode === 3) body.messages.unshift(...['代码','诗','提取','你好'].map(content => ({role:'user',content})));
  if (mode === 4) body.messages[0].content = [{type:'text',text}, {type:'image_url',image_url:{url:'data:'.repeat(2000)}}];
  if (mode === 5) body.tools = [{type:'function',function:{name:'web_search',parameters:{type:'object',properties:{'字段😀':{type:'string'}}}}}];
  if (mode === 6) body.response_format = {type:'json_schema',json_schema:{name:'schema',schema:{type:'object'}}};
  if (mode === 7) body.max_completion_tokens = '23.2';
  if (mode === 8) body.messages[0].role = 'system';
  if (mode === 9) body.messages.push({role:'user',content:[{type:'input_audio',input_audio:{data:'xxxx'}}]});
  if (mode === 10) body.messages.push({role:'tool',content:'<>&\u2028\u2029\t\n"\\\u0000😀'});
  if (mode === 11) body.functions = [{name:'old',parameters:{x:[null,true,false,1e-7,1e21]}}];
  rows.push({body,config:cfg});
}
for(const n of [79,80,81,199,200,201,499,500,501,1499,1500,1501]) rows.push({body:{messages:[{role:'user',content:'😀'.repeat(n)}]},config:cfg});
rows.push({body:{messages:[{role:'user',content:'定制任务 abc'}]},config:{...cfg,taskRules:{...cfg.taskRules,patterns:{coding:['定制任务']}}}});
const corpus=rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
const run=spawnSync(binary,['analyze'],{input:corpus,encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true});
if(run.error||run.status!==0)throw run.error||Error(run.stderr);
const results=run.stdout.trim().split('\n').map(JSON.parse);
if(results.length!==rows.length)throw Error('Missing output rows');
const mismatches=[];
for(let i=0;i<rows.length;i++){const expected=analyzeRequest(rows[i].body,rows[i].config);if(!isDeepStrictEqual(expected,results[i]))mismatches.push({index:i,expected,actual:results[i]});}
const hash=b=>createHash('sha256').update(b).digest('hex');
const report={scope:'L1 classification, confidence, signals, requirements and full request capacity',cases:rows.length,mismatchCount:mismatches.length,mismatches:mismatches.slice(0,20),corpusSha256:hash(corpus),binarySha256:hash(readFileSync(binary)),referenceSha256:hash(readFileSync(`${root}/src/router.mjs`)),at:new Date().toISOString()};
mkdirSync(`${root}/data/go-migration`,{recursive:true});writeFileSync(`${root}/data/go-migration/analysis-verification.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({cases:rows.length,mismatches:mismatches.length}));if(mismatches.length)process.exitCode=1;
