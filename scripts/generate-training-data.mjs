// 训练数据生成器 v3：按路由器生产语义（TASK_PATTERNS）锚定生成
// 用法：node scripts/generate-training-data.mjs [--count 2100] [--out data/training/raw.jsonl] [--concurrency 3]
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') && (a.push([v.slice(2), arr[i + 1]])), a), []));
const TOTAL = Number(args.count || 2100);
const OUT = args.out || 'data/training/raw.jsonl';
const CONC = Number(args.concurrency || 3);
const FRESH = args.fresh === '1';  // --fresh 1 忽略已有重新生成

const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.split('=')[0], l.split('=').slice(1).join('=')]));
const BASE = env.UPSTREAM_BASE_URL || env.MAAS_BASE_URL;
const KEY = env.MAAS_API_KEY;

// 任务定义与生产 TASK_PATTERNS 对齐：每任务=正例锚词 + 反例指引
const TASK_DEF = {
  coding: {
    desc: '编程开发类：写代码、改代码、调试报错、技术实现',
    must: '请求里必须出现编程语境词（代码/函数/脚本/bug/报错/接口/SQL/编译/python/java/前端/后端/库/框架代码级问题等）或附带代码片段',
    not: '纯业务架构讨论、方案选型（那是 reasoning）；确保是"要动手写/改代码"的请求',
    scenes: ['写脚本/工具', '修 bug/看报错', '写 SQL', '前端页面/样式', '后端接口实现', '数据处理代码', '代码审查/重构', '单元测试/正则', '调用 API/SDK 示例'],
  },
  reasoning: {
    desc: '分析推理类：多因素分析、方案对比、根因排查、决策权衡、数学证明',
    must: '请求必须含分析/推理诉求（为什么/原因/分析/对比/权衡/评估/规划/怎么选/证明/利弊/风险），且需要多步思考而非直接事实',
    not: '写代码实现（coding）；改写文案（creative）；从给定文本抽字段（extraction）',
    scenes: ['业务方案对比', '根因分析', '决策权衡', '数学/逻辑推理', '策略规划', '风险评估', '竞品分析', '流程优化分析'],
  },
  creative: {
    desc: '创作类：文案、故事、命名、营销、演讲稿等原创内容生成',
    must: '请求必须是要"创作原创内容"（写/编/起名/构思/文案/故事/诗/口号/脚本/策划案）',
    not: '基于给定材料总结提炼（extraction）；逻辑论证（reasoning）',
    scenes: ['营销文案', '品牌命名', '故事/剧本', '演讲稿/主持词', '社媒内容', '活动策划', '诗/歌词', '视频脚本'],
  },
  extraction: {
    desc: '结构化提取类：从给定文本/表格/日志中抽取字段、分类打标、转格式',
    must: '请求必须附带或引用"待处理材料"（这段/下列/以下/贴的文本/工单/合同/简历/表格/日志），要求提取、抽取、分类、打标签、转 JSON、找字段',
    not: '开放问答（default）；创作（creative）',
    scenes: ['工单分类打标', '合同/简历字段抽取', '会议纪要要点', '文本情感分类', '日志事件提取', '转结构化 JSON', '表格信息识别', '评论观点归纳'],
  },
  default: {
    desc: '一般对话与直接问答：闲聊、常识问答、翻译、格式转换、生活工作事务咨询',
    must: '请求是日常对话、单一事实问答、翻译、改写语气、简单咨询——不需要上面四类的专门特征',
    not: '含代码语境（coding）、多因素分析（reasoning）、原创创作（creative）、给定材料抽字段（extraction）',
    scenes: ['日常闲聊', '常识问答', '翻译', '措辞润色', '生活建议', '工作流程咨询', '邮件/消息代拟', '推荐/建议'],
  },
};
const TIER_GUIDE = {
  simple: '一两句话的短请求，目标单一明确，无多重约束（20~80字）',
  balanced: '中等长度请求，有一定上下文或两三个约束条件（80~300字）',
  complex: '长而复杂的请求，多目标、多重约束、权衡取舍或长链条要求（300~800字）',
};
const CELLS = [];
for (const task of ['default', 'coding', 'reasoning', 'creative', 'extraction'])
  for (const tier of ['simple', 'balanced', 'complex']) CELLS.push({ task, tier });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const existing = (!FRESH && existsSync(OUT)) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean) : [];
const have = {};
for (const line of existing) { try { const x = JSON.parse(line); const k = `${x.task}/${x.tier}`; have[k] = (have[k] || 0) + 1; } catch {} }
const perCell = Math.floor(TOTAL / CELLS.length);
mkdirSync(dirname(OUT), { recursive: true });
console.log(`目标 ${TOTAL}（每格 ${perCell}），已有 ${existing.length}，并发 ${CONC}`);

async function genBatch(cell, scene, n) {
  const def = TASK_DEF[cell.task];
  const prompt = `你是数据合成器。生成 ${n} 条【真实用户发给大模型助手的请求】，中文为主。
任务类型严格限定：${def.desc}
- 必须满足：${def.must}
- 禁止：${def.not}
- 本次场景：${scene}；难度档：${cell.tier}（${TIER_GUIDE[cell.tier]}）
- 语气多样（正式/口语/急促/客气），人称多样，开头别都用"请"
- 只输出 JSON 数组 [{"text":"..."}]，共 ${n} 条，互不相同`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'deepseekv4-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 4000, temperature: 1.0 }),
    });
    if (!r.ok) throw new Error(`MaaS ${r.status}`);
    const d = await r.json();
    const m = (d.choices?.[0]?.message?.content || '').match(/\[[\s\S]*\]/);
    if (!m) return [];
    let arr; try { arr = JSON.parse(m[0]); } catch { return []; }
    return arr.filter(x => typeof x?.text === 'string' && x.text.length >= 10).map(x => ({
      text: x.text.trim(), task: cell.task, tier: cell.tier,
      complexity: cell.tier === 'simple' ? +(0.1 + Math.random() * 0.25).toFixed(2)
               : cell.tier === 'balanced' ? +(0.35 + Math.random() * 0.3).toFixed(2)
               : +(0.7 + Math.random() * 0.28).toFixed(2),
      source: 'synthetic-v3',
    }));
  } finally { clearTimeout(to); }
}

async function runCell(cell) {
  const key = `${cell.task}/${cell.tier}`;
  let got = have[key] || 0, attempts = 0;
  const scenes = TASK_DEF[cell.task].scenes;
  while (got < perCell && attempts < 6) {
    const scene = scenes[(attempts + Math.floor(Math.random() * scenes.length)) % scenes.length];
    try {
      const batch = await genBatch(cell, scene, Math.min(25, perCell - got));
      if (batch.length) {
        appendFileSync(OUT, batch.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
        got += batch.length;
        console.log(`[${key}] +${batch.length} → ${got}/${perCell}`);
      }
    } catch (e) { console.log(`[${key}] 重试: ${e.message}`); await sleep(2000); }
    attempts++;
  }
  return got;
}

const queue = [...CELLS];
let done = 0, total = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const cell = queue.shift();
    if (!cell) break;
    const n = await runCell(cell);
    total += n; done++;
    console.log(`完成 ${done}/15 格，累计 ${total} 条`);
  }
}));
console.log(`DONE 总计 ${total} 条 → ${OUT}`);
