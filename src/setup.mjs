// Comandos de instalação: preparam o .env e chamam a CLI do Supabase por baixo, sem mostrar senha nem chave na tela.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ENV_FILE, ROOT, readEnv, writeEnvValue } from './env.mjs';

export const SUPABASE_CLI = 'supabase@3.2.0';
const REF = /^[a-z]{20}$/;
const SECRET_KEY = /sb_secret_[A-Za-z0-9_-]{10,}/;
const WAIT_MS = 15000;

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Roda "npx supabase@3 ..." na pasta do publicador. capture: devolve a saída em vez de mostrar na tela.
export function runSupabase(args, { capture = false, env = {} } = {}) {
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? 'npx.cmd' : 'npx', ['--yes', SUPABASE_CLI, ...args], {
    cwd: ROOT, shell: windows, encoding: 'utf8', env: { ...process.env, ...env },
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw new Error(`Não consegui rodar a CLI do Supabase: ${result.error.message}`);
  return { ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}` };
}

export function prepareCommand({ log, envFile = ENV_FILE, exampleFile = path.join(ROOT, '.env.example') }) {
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(exampleFile, envFile);
    fs.chmodSync(envFile, 0o600);
    log('Criei o arquivo .env a partir do .env.example.');
  }
  if (!readEnv(envFile).SUPABASE_DB_PASSWORD) {
    writeEnvValue('SUPABASE_DB_PASSWORD', crypto.randomBytes(16).toString('hex'), envFile);
    log('Gerei uma senha forte para o banco e guardei no .env (SUPABASE_DB_PASSWORD).');
  }
  log('Próximo passo: npx supabase@3.2.0 login (abre o navegador para você entrar no Supabase).');
  return { envFile };
}

export function findRef(output) {
  try {
    const data = JSON.parse(output);
    const candidate = [data?.ref, data?.id, data?.project?.ref].find(value => REF.test(value || ''));
    if (candidate) return candidate;
  } catch {
    // A saída não é JSON puro; procura no texto.
  }
  return output.match(/\b[a-z]{20}\b/)?.[0] || null;
}

export function saveProject(ref, { log, envFile = ENV_FILE }) {
  if (!REF.test(ref || '')) throw new Error('O ID do projeto do Supabase tem 20 letras minúsculas (aparece no endereço do painel).');
  writeEnvValue('SUPABASE_PROJECT_REF', ref, envFile);
  writeEnvValue('SUPABASE_URL', `https://${ref}.supabase.co`, envFile);
  log(`Projeto ${ref} guardado no .env (SUPABASE_URL=https://${ref}.supabase.co).`);
}

// Cria um projeto novo (grátis) ou usa um que já existe (--ref) e liga a pasta a ele.
export function projectCommand(options, { log, envFile = ENV_FILE, run = runSupabase }) {
  const env = readEnv(envFile);
  if (!env.SUPABASE_DB_PASSWORD) throw new Error('Rode antes: npm run preparar');
  let ref = options.ref;
  if (!ref) {
    if (!options.org) throw new Error('Informe a organização (--org, veja em npx supabase@3.2.0 orgs list) ou um projeto que já existe (--ref).');
    const created = run(['projects', 'create', options.name || 'publicador-instagram', '--org-id', options.org,
      '--region', options.region || 'sa-east-1', '--db-password', env.SUPABASE_DB_PASSWORD, '-o', 'json', '--yes'], { capture: true });
    ref = created.ok ? findRef(created.output) : null;
    if (!ref) throw new Error(`O Supabase não criou o projeto: ${created.output.slice(0, 400)}`);
    log(`Projeto criado no Supabase: ${ref}. Ele leva cerca de 2 minutos para ficar pronto.`);
  }
  saveProject(ref, { log, envFile });
  for (let attempt = 1; attempt <= 12; attempt++) {
    const linked = run(['link', '--project-ref', ref, '--yes'], { capture: true, env: { SUPABASE_DB_PASSWORD: env.SUPABASE_DB_PASSWORD } });
    if (linked.ok) { log('Pasta ligada ao projeto do Supabase.'); return { ref }; }
    if (attempt === 12) throw new Error(`Não consegui ligar a pasta ao projeto: ${linked.output.slice(0, 400)}`);
    log('O projeto ainda está subindo; tento de novo em 15 segundos...');
    sleepSync(WAIT_MS);
  }
  return { ref };
}

function retry(label, args, { log, run, env, attempts = 8 }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = run(args, { capture: true, env });
    if (result.ok) return result;
    if (attempt === attempts) throw new Error(`${label} falhou: ${result.output.slice(-600)}`);
    log(`${label}: o Supabase ainda não respondeu; tento de novo em 15 segundos...`);
    sleepSync(WAIT_MS);
  }
  return null;
}

// Aplica a migração, publica a função e grava a chave secreta no .env, sem mostrá-la.
export function installCommand({ log, envFile = ENV_FILE, run = runSupabase }) {
  const env = readEnv(envFile);
  if (!REF.test(env.SUPABASE_PROJECT_REF || '')) throw new Error('Rode antes: npm run supabase:projeto -- --org <id> (ou --ref <projeto>)');
  const password = { SUPABASE_DB_PASSWORD: env.SUPABASE_DB_PASSWORD };
  retry('Migração do banco', ['db', 'push', '--remote', '-p', env.SUPABASE_DB_PASSWORD, '--yes'], { log, run, env: password });
  log('Banco pronto: tabelas, cofre, bucket privado e agendador criados.');
  retry('Publicação da função', ['functions', 'deploy', 'publicador', '--no-verify-jwt', '--use-api', '--yes'], { log, run, env: password });
  log('Função publicador no ar.');
  const keys = retry('Leitura da chave secreta', ['projects', 'api-keys', '--reveal', '-o', 'json'], { log, run, env: password });
  saveKeyCommand({}, { log, input: keys.output, envFile });
  return { ref: env.SUPABASE_PROJECT_REF };
}

export function saveKeyCommand(options, { log, input, envFile = ENV_FILE }) {
  const key = String(input || '').match(SECRET_KEY)?.[0];
  if (!key) {
    throw new Error('Não achei a chave secreta (sb_secret_...). No painel do Supabase: Settings → API Keys → Secret keys → copie e cole no .env, na linha SUPABASE_SECRET_KEY.');
  }
  writeEnvValue('SUPABASE_SECRET_KEY', key, envFile);
  if (options.ref) saveProject(options.ref, { log, envFile });
  log(`Chave secreta guardada no .env (termina em ${key.slice(-4)}); ela não aparece em mais nenhum lugar.`);
  return { saved: true };
}
