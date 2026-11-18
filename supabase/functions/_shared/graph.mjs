// Cliente da API do Instagram (Graph API da Meta) e do login do Facebook para Empresas.
// Roda só no servidor: as chaves nunca vão para o navegador nem para os registros.

const ACCOUNT_ID = /^[0-9]{5,40}$/;
const USERNAME = /^[A-Za-z0-9_.]{1,30}$/;
const GRAPH_PATH = /^[0-9]+(?:\/(?:media|media_publish|content_publishing_limit))?$/;
const TIMEOUT_MS = 30000;

function assert(value, message) {
  if (!value) throw new Error(message);
}

// code: código de erro da Meta. uncertain: a escrita pode ter acontecido, então nunca se repete às cegas.
export class MetaError extends Error {
  constructor(message, { code = null, subcode = null, status = 0, uncertain = false, detail = '' } = {}) {
    super(message);
    this.code = code;
    this.subcode = subcode;
    this.status = status;
    this.uncertain = uncertain;
    this.detail = detail;
  }
}

async function readJson(response, method) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new MetaError('Resposta da Meta não confirmada.', { status: response.status, uncertain: method === 'POST' });
  }
  if (response.ok && !data?.error) return data;
  const code = Number(data?.error?.code) || null;
  throw new MetaError(`A Meta recusou a operação (código ${code || response.status}).`, {
    code,
    subcode: Number(data?.error?.error_subcode) || null,
    status: response.status,
    uncertain: method === 'POST' && response.status >= 500,
    detail: String(data?.error?.message || '').slice(0, 200),
  });
}

async function send(fetchImpl, url, options) {
  try {
    return await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), ...options });
  } catch {
    throw new MetaError('Resposta da Meta não confirmada.', { uncertain: options.method === 'POST' });
  }
}

// A chave da Página publica pelo graph.facebook.com usando o ID da conta profissional do Instagram.
export class InstagramClient {
  constructor({ token, version, fetchImpl = fetch, mediaHosts = [] }) {
    assert(token && /^v\d+\.\d+$/.test(version || ''), 'Configure a chave e a versão da API da Meta.');
    this.token = token;
    this.base = `https://graph.facebook.com/${version}`;
    this.fetch = fetchImpl;
    this.mediaHosts = new Set(mediaHosts);
  }

  async request(path, { method = 'GET', values = {} } = {}) {
    assert(GRAPH_PATH.test(path), 'Destino da Meta inválido.');
    const url = new URL(`${this.base}/${path}`);
    const headers = { Authorization: `Bearer ${this.token}` };
    const options = { method, headers };
    if (method === 'GET') {
      for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.body = new URLSearchParams(values);
    }
    return readJson(await send(this.fetch, url, options), method);
  }

  // A Meta só busca mídia no armazenamento deste projeto, por link assinado.
  #mediaUrl(address) {
    const url = new URL(address);
    assert(url.protocol === 'https:' && !url.username && !url.password && this.mediaHosts.has(url.hostname),
      'Arquivo fora do armazenamento autorizado.');
    return url.href;
  }

  image(igUserId, address, { caption = '', carouselItem = false } = {}) {
    const values = { image_url: this.#mediaUrl(address) };
    if (carouselItem) values.is_carousel_item = 'true';
    else values.caption = caption;
    return this.request(`${igUserId}/media`, { method: 'POST', values });
  }

  reel(igUserId, address, caption) {
    const values = { media_type: 'REELS', video_url: this.#mediaUrl(address), caption, share_to_feed: 'true' };
    return this.request(`${igUserId}/media`, { method: 'POST', values });
  }

  carousel(igUserId, children, caption) {
    assert(children.length >= 2 && children.length <= 10, 'O carrossel precisa de 2 a 10 imagens.');
    const values = { media_type: 'CAROUSEL', children: children.join(','), caption };
    return this.request(`${igUserId}/media`, { method: 'POST', values });
  }

  status(containerId) {
    return this.request(containerId, { values: { fields: 'id,status_code,status' } });
  }

  publish(igUserId, containerId) {
    return this.request(`${igUserId}/media_publish`, { method: 'POST', values: { creation_id: containerId } });
  }

  media(mediaId) {
    return this.request(mediaId, { values: { fields: 'id,permalink,timestamp,media_type' } });
  }

  recentMedia(igUserId) {
    return this.request(`${igUserId}/media`, { values: { fields: 'id,caption,permalink,timestamp', limit: '10' } });
  }

  account(igUserId) {
    return this.request(igUserId, { values: { fields: 'id,username,media_count' } });
  }

  publishingLimit(igUserId) {
    return this.request(`${igUserId}/content_publishing_limit`, { values: { fields: 'quota_usage,config' } });
  }
}

// Tela oficial da Meta (login do Facebook para Empresas, com o ID da configuração do login).
export function loginDialogUrl({ appId, configId, redirectUri, state }) {
  const url = new URL('https://www.facebook.com/dialog/oauth');
  const values = {
    client_id: appId, config_id: configId, redirect_uri: redirectUri, response_type: 'code',
    override_default_response_type: 'true', prompt: 'login', state,
  };
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  return url.href;
}

async function graphGet(fetchImpl, version, path, values, token) {
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return readJson(await send(fetchImpl, url, { method: 'GET', headers }), 'GET');
}

// Confere o ID do app e a chave secreta pedindo à Meta a chave do próprio app.
export async function checkAppCredentials({ appId, appSecret, version, fetchImpl = fetch }) {
  const data = await graphGet(fetchImpl, version, 'oauth/access_token',
    { client_id: appId, client_secret: appSecret, grant_type: 'client_credentials' });
  assert(data?.access_token, 'A Meta não confirmou o app.');
  return true;
}

export async function exchangeCode({ appId, appSecret, redirectUri, code, version, fetchImpl = fetch }) {
  const data = await graphGet(fetchImpl, version, 'oauth/access_token',
    { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
  assert(data?.access_token, 'A Meta não devolveu a autorização.');
  return data.access_token;
}

// A chave de usuário vira de longa duração (60 dias); a chave de Página tirada dela não vence.
export async function longLivedUserToken({ appId, appSecret, token, version, fetchImpl = fetch }) {
  const data = await graphGet(fetchImpl, version, 'oauth/access_token',
    { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token });
  assert(data?.access_token, 'A Meta não devolveu a chave de longa duração.');
  return data.access_token;
}

// Permissões e validade como a Meta enxerga. expires_at 0 significa que a chave não vence.
export async function inspectToken({ token, appId, appSecret, version, fetchImpl = fetch }) {
  const { data } = await graphGet(fetchImpl, version, 'debug_token',
    { input_token: token, access_token: `${appId}|${appSecret}` });
  assert(data?.is_valid && String(data.app_id) === String(appId), 'A Meta não confirmou a chave deste app.');
  const granular = data.granular_scopes || [];
  const scopes = data.scopes?.length ? data.scopes : granular.map(item => item.scope);
  const targets = [...new Set(granular.filter(item => /^instagram_/.test(item.scope))
    .flatMap(item => item.target_ids || []).map(String))].filter(id => ACCOUNT_ID.test(id));
  const expiresAt = Number(data.expires_at) > 0 ? new Date(Number(data.expires_at) * 1000).toISOString() : null;
  return { scopes, targets, type: String(data.type || ''), expiresAt };
}

const validAccount = item => ACCOUNT_ID.test(String(item?.id)) && USERNAME.test(item?.username || '');
const asAccount = item => ({ id: String(item.id), username: item.username });
const listOf = data => (Array.isArray(data?.data) ? data.data : []);

async function graphTry(fetchImpl, token, version, path, fields) {
  try {
    return { ok: true, data: await graphGet(fetchImpl, version, path, fields ? { fields } : {}, token) };
  } catch (error) {
    return { ok: false, code: error.code || error.status || 'x' };
  }
}

// Procura o Instagram compartilhado em todos os lugares em que a Meta pode mostrá-lo.
// O relatório tem só contagens e códigos de erro; IDs e @ são públicos e a chave não sai daqui.
export async function probeInstagramAccounts({ token, version, targets = [], fetchImpl = fetch }) {
  const report = {};
  const found = [];
  const pageTokens = {};
  const record = (name, result, pick) => {
    if (!result.ok) { report[name] = `erro${result.code}`; return; }
    const accounts = pick(result.data).filter(validAccount).map(asAccount);
    report[name] = accounts.length;
    found.push(...accounts);
  };
  record('paginas', await graphTry(fetchImpl, token, version, 'me/accounts',
    'id,access_token,instagram_business_account{id,username}'), data => listOf(data).map(page => {
    const instagram = page.instagram_business_account;
    if (validAccount(instagram) && typeof page.access_token === 'string') pageTokens[String(instagram.id)] = page.access_token;
    return instagram;
  }));
  record('atribuidas', await graphTry(fetchImpl, token, version, 'me/assigned_instagram_accounts', 'id,username'), listOf);
  for (const [index, id] of targets.entries()) {
    record(`alvo${index + 1}`, await graphTry(fetchImpl, token, version, id, 'id,username'), data => [data]);
  }
  const accounts = [...new Map(found.map(item => [item.id, item])).values()];
  return { accounts, report, pageTokens };
}
