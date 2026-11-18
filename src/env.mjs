// Lê e atualiza o arquivo .env da pasta do publicador. Ele nunca vai para o Git (.gitignore).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = path.join(ROOT, '.env');
const LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;

export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const match = line.match(LINE);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

export function readEnv(file = ENV_FILE) {
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
}

const PLACEHOLDER = /SEU-PROJETO|COLE-AQUI|^$/;

export function requireEnv(env, names) {
  const missing = names.filter(name => PLACEHOLDER.test(env[name] || ''));
  if (missing.length) {
    throw new Error(`Falta preencher no arquivo .env: ${missing.join(', ')}. Veja o passo a passo em INSTALAR.md.`);
  }
  return env;
}

// Troca o valor de uma linha (ou acrescenta no fim), preservando o resto do arquivo.
export function writeEnvValue(name, value, file = ENV_FILE) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex(line => line.match(LINE)?.[1] === name);
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, `${name}=${value}`);
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}
