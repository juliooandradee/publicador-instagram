// Conexão do Instagram pela tela oficial da Meta (login do Facebook para Empresas).
// 1. A linha de comando pede um link (start). 2. A pessoa autoriza na Meta. 3. A Meta volta aqui (callback),
// a chave da Página vai para o Vault e a pessoa vê um texto simples dizendo o resultado.
import { exchangeCode, inspectToken, loginDialogUrl, longLivedUserToken, probeInstagramAccounts } from './graph.mjs';

const RETRIES = 3;
const RETRY_WAIT_MS = 2000;
const BACK = 'Pode fechar esta janela e voltar ao Claude Code ou ao Codex.';

// Recusas do banco que a pessoa consegue resolver.
const SAVE_ERRORS = {
  username_mismatch: 'outra-conta',
  missing_publish_scope: 'sem-permissao',
  instagram_in_use: 'em-uso',
};

export const CONNECTION_TEXTS = {
  conectado: info => `Pronto! O Instagram @${info.username} está conectado ao seu publicador.\n\n${BACK}`,
  cancelado: () => `Você cancelou a autorização na tela da Meta. Nada foi conectado.\n\n${BACK}`,
  invalido: () => 'Este link de conexão não é válido. Volte ao Claude Code ou ao Codex e gere outro com: npm run conectar',
  expirado: () => 'Este pedido de conexão expirou (vale 30 minutos) ou já foi usado. Gere outro com: npm run conectar',
  'nao-configurado': () => 'O app da Meta ainda não foi configurado no publicador. Rode: npm run configurar',
  'erro-meta': info => `A Meta não confirmou a conexão (etapa: ${info.stage}). Confira o ID do app, a chave secreta e o `
    + `endereço de retorno no app da Meta, e tente de novo em alguns minutos.\n\n${BACK}`,
  'sem-conta': info => 'A Meta aprovou, mas não mostrou nenhum Instagram ligado a uma Página do Facebook. Confira se o '
    + 'Instagram é profissional e está ligado a uma Página que você administra, e se você marcou essa Página e esse '
    + `Instagram na tela da Meta. Depois rode: npm run conectar -- --retomar\n\nDiagnóstico: ${info.report}`,
  'outra-conta': info => `A Meta mostrou ${info.found || 'outro Instagram'}, mas não o @${info.expected}. `
    + 'Rode de novo escolhendo o certo: npm run conectar -- --retomar --instagram @usuario',
  'varias-contas': info => `A Meta mostrou mais de um Instagram (${info.found}). Diga qual usar: `
    + 'npm run conectar -- --retomar --instagram @usuario',
  'sem-permissao': () => 'A permissão de publicar (instagram_content_publish) não foi concedida. Confira as permissões '
    + 'da configuração do login no app da Meta e conecte de novo aceitando todas.',
  'em-uso': () => 'Esse Instagram já está conectado a outra conta deste publicador. Desconecte lá antes.',
  erro: () => 'Não foi possível salvar a conexão. Tente de novo com: npm run conectar',
};

export function pickAccount(accounts, expected) {
  if (expected) return accounts.find(item => item.username.toLowerCase() === expected.toLowerCase()) || null;
  return accounts.length === 1 ? accounts[0] : null;
}

const handles = accounts => accounts.map(item => `@${item.username}`).join(', ');
const reportText = (granted, report) => [`tipo${granted.type || '0'}`, `escopos${granted.scopes.length}`,
  ...Object.entries(report).map(([name, value]) => `${name}${value}`)].join('-').replace(/[^A-Za-z0-9._-]/g, '');

// Escolhe o Instagram certo entre os que a Meta mostrou, ou explica por que não deu.
export function chooseAccount(shared, expected) {
  if (!shared.accounts.length) return { code: 'sem-conta' };
  const account = pickAccount(shared.accounts, expected);
  if (account) return { account };
  return { code: expected ? 'outra-conta' : 'varias-contas', found: handles(shared.accounts), expected };
}

export function makeConnect({ rest, redirectUri, fetcher = fetch, sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  async function metaConfig() {
    const config = await rest.rpc('instagram_publisher_meta_config');
    const ready = /^[0-9]+$/.test(config?.app_id || '') && config?.app_secret && /^[0-9]+$/.test(config?.config_id || '');
    return ready ? config : null;
  }

  // A Página pode levar alguns segundos para mostrar o Instagram compartilhado.
  async function sharedAccounts(token, granted, version) {
    let probe;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      probe = await probeInstagramAccounts({ token, version, targets: granted.targets, fetchImpl: fetcher });
      if (probe.accounts.length) return probe;
      if (attempt < RETRIES - 1) await sleep(RETRY_WAIT_MS);
    }
    return probe;
  }

  // O Instagram alcançado por uma Página é salvo com a chave dessa Página: ela não vence.
  async function save(config, accountId, account, token, granted, shared) {
    let saved = token;
    let { scopes, expiresAt } = granted;
    const pageToken = shared.pageTokens?.[account.id];
    if (pageToken) {
      saved = pageToken;
      try {
        ({ scopes, expiresAt } = await inspectToken({ token: pageToken, appId: config.app_id,
          appSecret: config.app_secret, version: config.graph_version, fetchImpl: fetcher }));
      } catch {
        // Mantém as permissões vistas na chave do usuário.
      }
    }
    await rest.rpc('instagram_publisher_save_connection', { p_account: accountId, p_ig_user_id: account.id,
      p_username: account.username, p_token: saved, p_scopes: scopes, p_expires_at: expiresAt });
  }

  async function settle(config, pending, token, granted, shared) {
    const choice = chooseAccount(shared, pending.expected_username);
    if (!choice.account) {
      await rest.rpc('instagram_publisher_keep_pending', { p_account: pending.account_id, p_token: token, p_scopes: granted.scopes })
        .catch(() => null);
      return { code: choice.code, info: { ...choice, report: reportText(granted, shared.report) } };
    }
    try {
      await save(config, pending.account_id, choice.account, token, granted, shared);
      return { code: 'conectado', info: { username: choice.account.username } };
    } catch (error) {
      return { code: SAVE_ERRORS[error.message] || 'erro', info: { expected: pending.expected_username, found: '' } };
    }
  }

  async function start(body) {
    const config = await metaConfig();
    if (!config) return [{ error: CONNECTION_TEXTS['nao-configurado']() }, 409];
    const begun = await rest.rpc('instagram_publisher_oauth_begin', {
      p_account_key: body.account || 'principal', p_expected_username: body.expected_username || null });
    const url = loginDialogUrl({ appId: config.app_id, configId: config.config_id, redirectUri, state: begun.state });
    return [{ url, account: begun.account, expected_username: begun.expected_username, expires_in_minutes: 30 }, 200];
  }

  // "Retomar": procura de novo com a chave que ficou esperando, sem novo login nem SMS.
  async function resume(body) {
    const config = await metaConfig();
    if (!config) return [{ error: CONNECTION_TEXTS['nao-configurado']() }, 409];
    const pending = await rest.rpc('instagram_publisher_take_pending', {
      p_account_key: body.account || 'principal', p_expected_username: body.expected_username || null });
    if (!pending?.token) return [{ error: 'Não há conexão esperando. Rode: npm run conectar' }, 409];
    let granted;
    let shared;
    try {
      granted = await inspectToken({ token: pending.token, appId: config.app_id, appSecret: config.app_secret,
        version: config.graph_version, fetchImpl: fetcher });
      shared = await sharedAccounts(pending.token, granted, config.graph_version);
    } catch {
      return [{ error: 'A Meta não respondeu. Tente de novo em alguns minutos.' }, 502];
    }
    const result = await settle(config, pending, pending.token, granted, shared);
    const text = CONNECTION_TEXTS[result.code](result.info);
    return result.code === 'conectado' ? [{ ok: true, username: result.info.username, message: text }, 200] : [{ error: text }, 409];
  }

  async function callback(params) {
    if (params.get('error')) return [CONNECTION_TEXTS.cancelado(), 200];
    const state = params.get('state') || '';
    const code = params.get('code') || '';
    if (!/^[0-9a-f]{64}$/.test(state) || !code || code.length > 2048) return [CONNECTION_TEXTS.invalido(), 400];
    const config = await metaConfig();
    if (!config) return [CONNECTION_TEXTS['nao-configurado'](), 409];
    const pending = await rest.rpc('instagram_publisher_oauth_consume', { p_state: state }).catch(() => null);
    if (!pending?.account_id) return [CONNECTION_TEXTS.expirado(), 410];
    const meta = { appId: config.app_id, appSecret: config.app_secret, version: config.graph_version, fetchImpl: fetcher };
    let token;
    let granted;
    let shared;
    let stage = 'troca do código';
    try {
      token = await exchangeCode({ ...meta, redirectUri, code });
      token = await longLivedUserToken({ ...meta, token }).catch(() => token);
      stage = 'leitura da chave';
      granted = await inspectToken({ ...meta, token });
      stage = 'busca do Instagram';
      shared = await sharedAccounts(token, granted, config.graph_version);
    } catch {
      return [CONNECTION_TEXTS['erro-meta']({ stage }), 502];
    }
    const result = await settle(config, pending, token, granted, shared);
    return [CONNECTION_TEXTS[result.code](result.info), result.code === 'conectado' ? 200 : 409];
  }

  return { start, resume, callback };
}
