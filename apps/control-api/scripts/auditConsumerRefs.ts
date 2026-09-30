import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBrainGenome } from '../src/brainSelfImprove/brainGenome.js';

const keys = Object.keys(defaultBrainGenome()).filter(
  (k) => !['version', 'updated_at', 'last_lesson', 'explore_step'].includes(k)
);
const dirs = ['./src/services', './src/brainSelfImprove'];
const files: { f: string; src: string }[] = [];
for (const d of dirs) {
  for (const name of readdirSync(d)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    if (name === 'brainGenome.ts') continue;
    files.push({ f: join(d, name), src: readFileSync(join(d, name), 'utf8') });
  }
}

const onlySchema: string[] = [];
for (const k of keys) {
  const re = new RegExp(`(?:\\.|['"])${k}(?:['"]|\\b)`);
  const hits = files.filter((x) => re.test(x.src));
  if (!hits.length) onlySchema.push(k);
}
console.log('Keys with NO consumer outside brainGenome.ts:', onlySchema.length);
console.log(onlySchema.sort().join('\n'));
