import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readEnv } from '../src/env.mjs';
import { findRef, installCommand, prepareCommand, projectCommand, saveKeyCommand } from '../src/setup.mjs';

const REF = 'abcdefghijklmnopqrst';
const SECRET = 'sb_secret_TesteDeInstalacao_1234567890';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publicador-setup-'));
  const example = path.join(dir, '.env.example');
  fs.writeFileSync(example, 'SUPABASE_URL=https://SEU-PROJETO.supabase.co\nSUPABASE_SECRET_KEY=COLE-AQUI\nSUPABASE_DB_PASSWORD=\n');
  return { envFile: path.join(dir, '.env'), example };
}

test('preparar cria o .env com senha forte e não troca a senha numa segunda vez', () => {
  const { envFile, example } = sandbox();
  const lines = [];
  prepareCommand({ log: line => lines.push(line), envFile, exampleFile: example });
  const first = readEnv(envFile).SUPABASE_DB_PASSWORD;
  assert.match(first, /^[0-9a-f]{32}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  prepareCommand({ log: () => {}, envFile, exampleFile: example });
  assert.equal(readEnv(envFile).SUPABASE_DB_PASSWORD, first);
  assert.ok(!lines.join('\n').includes(first), 'a senha não pode aparecer na tela');
});

test('acha o ID do projeto na saída da CLI', () => {
  assert.equal(findRef(JSON.stringify({ id: REF, name: 'publicador-instagram' })), REF);
  assert.equal(findRef(`Created a new project publicador-instagram at https://supabase.com/dashboard/project/${REF}`), REF);
  assert.equal(findRef('erro'), null);
});

test('criar projeto: cria, guarda o endereço no .env e liga a pasta, sem mostrar a senha', () => {
  const { envFile, example } = sandbox();
  prepareCommand({ log: () => {}, envFile, exampleFile: example });
  const calls = [];
  const run = (args, options) => {
    calls.push({ args, options });
    return args[0] === 'projects' ? { ok: true, output: JSON.stringify({ id: REF }) } : { ok: true, output: '' };
  };
  const lines = [];
  projectCommand({ org: 'org-teste' }, { log: line => lines.push(line), envFile, run });
  assert.deepEqual(calls.map(call => call.args[0]), ['projects', 'link']);
  assert.ok(calls[0].args.includes('sa-east-1'));
  assert.equal(readEnv(envFile).SUPABASE_URL, `https://${REF}.supabase.co`);
  assert.ok(!lines.join('\n').includes(readEnv(envFile).SUPABASE_DB_PASSWORD));
});

test('instalar: banco, função e chave secreta, que vai para o .env e não para a tela', () => {
  const { envFile, example } = sandbox();
  prepareCommand({ log: () => {}, envFile, exampleFile: example });
  fs.appendFileSync(envFile, `SUPABASE_PROJECT_REF=${REF}\n`);
  const calls = [];
  const run = args => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'projects') return { ok: true, output: JSON.stringify([{ name: 'anon', api_key: 'sb_publishable_x' }, { name: 'default', api_key: SECRET }]) };
    return { ok: true, output: '' };
  };
  const lines = [];
  installCommand({ log: line => lines.push(line), envFile, run });
  assert.deepEqual(calls, ['db push', 'functions deploy', 'projects api-keys']);
  assert.equal(readEnv(envFile).SUPABASE_SECRET_KEY, SECRET);
  assert.ok(!lines.join('\n').includes(SECRET), 'a chave não pode aparecer na tela');
  assert.ok(lines.some(line => line.includes('termina em 7890')));
});

test('salvar-chave recusa entrada sem chave secreta', () => {
  const { envFile } = sandbox();
  assert.throws(() => saveKeyCommand({}, { log: () => {}, input: '[{"api_key":"sb_publishable_x"}]', envFile }), /Não achei a chave secreta/);
});
