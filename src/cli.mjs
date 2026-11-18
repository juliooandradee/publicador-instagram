// Linha de comando do publicador: lê os argumentos, monta o contexto e chama o comando.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApi } from './api.mjs';
import * as commands from './commands.mjs';
import { readEnv, requireEnv, writeEnvValue } from './env.mjs';
import { installCommand, prepareCommand, projectCommand, saveKeyCommand } from './setup.mjs';
import { DEFAULT_TIME_ZONE } from './time.mjs';

export const HELP = `Publicador de Instagram: foto, carrossel e Reels pela API oficial da Meta, no seu Supabase.

Uso: npm run <comando> -- [opções]

Instalação (uma vez):
  preparar                    Cria o .env e uma senha forte para o banco.
  supabase:projeto --org <id> Cria um projeto grátis no Supabase (ou --ref <id> para usar um que já existe).
  supabase:instalar           Aplica o banco, publica a função e guarda a chave secreta no .env.

Dia a dia:
  status                      Mostra a conexão, o agendador e a fila.
  configurar                  Liga o agendador e guarda o app da Meta (lê o .env).
  conectar --instagram @x     Abre a tela oficial da Meta para conectar o Instagram.
           --retomar          Termina uma conexão que ficou esperando, sem novo login.
  conferir                    Pergunta à Meta se o acesso está ok (@, posts e cota do dia).
  publicar <arquivos>         Cria o post: 1 imagem (foto), 2 a 10 imagens (carrossel) ou 1 vídeo (Reels).
           --legenda "..." ou --legenda-arquivo legenda.txt   (obrigatório)
           --teste            Pede ao Instagram para montar o post, sem publicar.
           --quando "2026-11-20 09:00"   Agenda no horário do seu fuso (FUSO_HORARIO no .env).
           --agora            Publica agora.
           --titulo "..."     Nome interno do post na fila.
           --comprimir        Recomprime o vídeo para caber em 50 MB (precisa do ffmpeg).
  testar <id> [--status]      Testa de novo um post sem publicar (ou confere o teste do vídeo).
  agendar <id> --quando "..." Agenda (ou muda o horário de) um post da fila. Também aceita --agora.
  cancelar <id>               Tira um post da fila antes de sair.
  fila [--limite 20]          Lista os posts e o estado de cada um.
  limpar                      Apaga do armazenamento as mídias de posts já publicados.
  desconectar --sim           Apaga a chave do Instagram do cofre.

Em todos: --conta <nome> (padrão: principal) e --json (saída para programas).
Exemplos:
  npm run publicar -- --legenda-arquivo legenda.txt --teste 01.jpg 02.jpg 03.jpg
  npm run publicar -- --legenda "Novo horário de atendimento" --quando "2026-11-20 09:00" foto.jpg
  npm run publicar -- --legenda-arquivo legenda.txt --comprimir --teste video.mp4`;

const ACCOUNT = { conta: { type: 'string' } };
// Comandos de instalação: rodam antes de o .env estar completo.
const SETUP = {
  preparar: { options: {}, run: (values, ctx) => prepareCommand(ctx) },
  'supabase-projeto': {
    options: { org: { type: 'string' }, ref: { type: 'string' }, regiao: { type: 'string' }, nome: { type: 'string' } },
    run: (values, ctx) => projectCommand({ org: values.org, ref: values.ref, region: values.regiao, name: values.nome }, ctx),
  },
  'supabase-instalar': { options: {}, run: (values, ctx) => installCommand(ctx) },
  'salvar-chave': {
    options: { ref: { type: 'string' } },
    run: (values, ctx) => {
      if (process.stdin.isTTY) throw new Error('Use com a saída da CLI: npx supabase@3.2.0 projects api-keys --reveal -o json | npm run --silent salvar-chave');
      return saveKeyCommand({ ref: values.ref }, { ...ctx, input: fs.readFileSync(0, 'utf8') });
    },
  },
};
const SPECS = {
  status: { options: {}, run: (values, ctx) => commands.statusCommand(ctx) },
  configurar: { options: {}, run: (values, ctx) => commands.configureCommand(ctx) },
  conectar: {
    options: { ...ACCOUNT, instagram: { type: 'string' }, retomar: { type: 'boolean' }, 'sem-navegador': { type: 'boolean' }, esperar: { type: 'string' } },
    run: (values, ctx) => commands.connectCommand({ account: values.conta, instagram: values.instagram, resume: values.retomar,
      noBrowser: values['sem-navegador'], wait: values.esperar ? Number(values.esperar) : undefined }, ctx),
  },
  conferir: { options: ACCOUNT, run: (values, ctx) => commands.checkCommand({ account: values.conta }, ctx) },
  publicar: {
    options: { ...ACCOUNT, legenda: { type: 'string' }, 'legenda-arquivo': { type: 'string' }, titulo: { type: 'string' },
      teste: { type: 'boolean' }, quando: { type: 'string' }, agora: { type: 'boolean' }, comprimir: { type: 'boolean' }, esperar: { type: 'string' } },
    run: (values, ctx, files) => commands.publishCommand({ account: values.conta, caption: values.legenda,
      captionFile: values['legenda-arquivo'], title: values.titulo, test: values.teste, when: values.quando, now: values.agora,
      compress: values.comprimir, wait: values.esperar ? Number(values.esperar) : undefined, files }, ctx),
  },
  testar: {
    options: { status: { type: 'boolean' } },
    run: (values, ctx, [id]) => commands.testCommand({ id, statusOnly: values.status }, ctx),
  },
  agendar: {
    options: { quando: { type: 'string' }, agora: { type: 'boolean' }, esperar: { type: 'string' } },
    run: (values, ctx, [id]) => commands.scheduleCommand({ id, when: values.quando, now: values.agora,
      wait: values.esperar ? Number(values.esperar) : undefined }, ctx),
  },
  cancelar: { options: {}, run: (values, ctx, [id]) => commands.cancelCommand({ id }, ctx) },
  fila: { options: { limite: { type: 'string' } }, run: (values, ctx) => commands.queueCommand({ limit: values.limite }, ctx) },
  limpar: { options: {}, run: (values, ctx) => commands.cleanCommand(ctx) },
  desconectar: {
    options: { ...ACCOUNT, sim: { type: 'boolean' } },
    run: (values, ctx) => commands.disconnectCommand({ account: values.conta, yes: values.sim }, ctx),
  },
};

// Abre o link no navegador padrão. Se não der, o link já foi mostrado na tela.
export function openUrl(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // Sem navegador: a pessoa copia o link.
  }
}

function checkTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone });
    return timeZone;
  } catch {
    throw new Error(`FUSO_HORARIO inválido no .env: ${timeZone}. Exemplo: America/Sao_Paulo.`);
  }
}

function readOptions(spec, argv) {
  try {
    return parseArgs({ args: argv, options: { ...spec.options, json: { type: 'boolean' } }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new Error(`${error.message.replace(/^Unknown option/, 'Opção desconhecida').replace(/^Option/, 'Opção')} Veja: npm run ajuda`);
  }
}

export async function main(argv, deps = {}) {
  const log = deps.log || (line => process.stdout.write(`${line}\n`));
  const fail = deps.fail || (line => process.stderr.write(`${line}\n`));
  const [name, ...rest] = argv;
  if (!name || ['ajuda', 'help', '-h', '--help'].includes(name)) { log(HELP); return 0; }
  const spec = SPECS[name] || SETUP[name];
  if (!spec) { fail(`Comando desconhecido: ${name}\n\n${HELP}`); return 1; }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publicador-'));
  try {
    const { values, positionals } = readOptions(spec, rest);
    if (SETUP[name]) {
      const result = await spec.run(values, { log, ...(deps.envFile ? { envFile: deps.envFile } : {}), ...(deps.run ? { run: deps.run } : {}) });
      if (values.json) log(JSON.stringify(result, null, 2));
      return 0;
    }
    const env = requireEnv(deps.env || readEnv(), ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']);
    const ctx = {
      api: deps.api || createApi({ url: env.SUPABASE_URL, key: env.SUPABASE_SECRET_KEY, fetcher: deps.fetcher }),
      env, log: values.json ? () => {} : log, timeZone: checkTimeZone(env.FUSO_HORARIO || DEFAULT_TIME_ZONE),
      sleep: deps.sleep || (ms => new Promise(done => setTimeout(done, ms))), openUrl: deps.openUrl || openUrl,
      workDir, writeEnv: deps.writeEnv || writeEnvValue, readFile: file => fs.readFileSync(file, 'utf8'), mediaTools: deps.mediaTools,
    };
    const result = await spec.run(values, ctx, positionals);
    if (values.json) log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    fail(`Erro: ${error.message}`);
    return 1;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
