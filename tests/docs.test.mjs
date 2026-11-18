import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('a skill é a mesma no Claude Code e no Codex', () => {
  assert.equal(read('.agents/skills/publicar-instagram/SKILL.md'), read('.claude/skills/publicar-instagram/SKILL.md'));
});

test('todo "npm run" citado nos roteiros existe no package.json', () => {
  const scripts = Object.keys(JSON.parse(read('package.json')).scripts);
  for (const file of ['README.md', 'INSTALAR.md', 'AGENTS.md', '.claude/skills/publicar-instagram/SKILL.md']) {
    for (const [, name] of read(file).matchAll(/npm run (?:--silent )?([a-z:-]+)/g)) {
      assert.ok(scripts.includes(name), `${file} cita "npm run ${name}", que não existe`);
    }
  }
});

test('a versão da CLI do Supabase citada nos roteiros é a mesma do código', async () => {
  const { SUPABASE_CLI } = await import('../src/setup.mjs');
  for (const file of ['INSTALAR.md']) {
    for (const [version] of read(file).matchAll(/supabase@[0-9.]+/g)) assert.equal(version, SUPABASE_CLI, file);
  }
});
