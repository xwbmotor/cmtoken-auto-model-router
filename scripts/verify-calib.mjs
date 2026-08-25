// 校准后 config 合法性验证
import { readFileSync } from 'node:fs';
import { validateConfig } from '../src/config.mjs';
const cfg = JSON.parse(readFileSync('config/router.json', 'utf8'));
validateConfig(cfg);
console.log('validateConfig OK');
for (const m of cfg.models) console.log(m.id, JSON.stringify(m.quality));
