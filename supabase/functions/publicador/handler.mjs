// Função "publicador" do Supabase. Uma só porta de entrada:
//   GET  com ?code&state  -> volta da tela da Meta (conexão do Instagram), responde em texto simples;
//   POST com x-publicador-cron -> o agendador do banco pedindo para processar a fila;
//   POST com a chave secreta do projeto -> comandos da linha de comando (configurar, conectar, testar...).
import { MetaError, checkAppCredentials } from '../_shared/graph.mjs';
import { makeConnect } from '../_shared/connect.mjs';
import { friendlyError, makePublisher } from '../_shared/publish.mjs';
import { RestError, UUID, createRest, presentedKey, sameSecret, serverKeys } from '../_shared/rest.mjs';

const MAX_BODY = 16384;
const FUNCTION_PATH = '/functions/v1/publicador';
const DATABASE_ERRORS = {
  not_found: ['Post não encontrado.', 404],
  not_connected: ['Conecte o Instagram antes (npm run conectar).', 409],
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
// O Supabase não serve HTML pelo endereço padrão das funções; a volta da Meta é um texto simples.
const text = (body, status = 200) => new Response(body, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
});

function failure(error) {
  if (Object.hasOwn(DATABASE_ERRORS, error?.message || '')) {
    const [message, status] = DATABASE_ERRORS[error.message];
    return json({ error: message }, status);
  }
  if (error instanceof MetaError) return json({ error: friendlyError(error).error }, 502);
  if (error instanceof RestError) return json({ error: error.message }, error.status >= 400 && error.status < 500 ? 409 : 502);
  return json({ error: `Não foi possível concluir: ${error?.message || 'erro desconhecido'}.` }, 500);
}

export function makeHandler({ env, fetcher = fetch, sleep = undefined, pollMs = undefined, budgetMs = undefined }) {
  const projectUrl = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const keys = serverKeys(env);
  const rest = createRest({ url: projectUrl, key: keys[0] || '', fetcher });
  const redirectUri = projectUrl + FUNCTION_PATH;
  const connect = makeConnect({ rest, redirectUri, fetcher, ...(sleep ? { sleep } : {}) });
  const publisherFor = async () => {
    const config = await rest.rpc('instagram_publisher_meta_config');
    return makePublisher({ rest, version: config?.graph_version || 'v26.0', mediaHost: new URL(projectUrl).hostname,
      fetcher, ...(sleep ? { sleep } : {}), ...(pollMs !== undefined ? { pollMs } : {}), ...(budgetMs ? { budgetMs } : {}) });
  };

  // Sem a chave secreta, reaproveita a que já está no cofre, desde que seja o mesmo app.
  async function metaFromBody(body) {
    if (!body.app_id) return null;
    const meta = { appId: String(body.app_id).trim(), appSecret: String(body.app_secret || '').trim(),
      configId: String(body.config_id || '').trim(), version: String(body.graph_version || 'v26.0').trim() };
    if (!meta.appSecret) {
      const stored = await rest.rpc('instagram_publisher_meta_config');
      if (stored?.app_id === meta.appId) meta.appSecret = stored.app_secret || '';
    }
    return meta;
  }

  async function configure(body) {
    const meta = await metaFromBody(body);
    if (meta && !meta.appSecret) return json({ error: 'Falta a chave secreta do app da Meta (META_APP_SECRET no .env).' }, 422);
    if (meta) {
      try {
        await checkAppCredentials({ ...meta, fetchImpl: fetcher });
      } catch {
        return json({ error: 'A Meta não reconheceu o ID do app com essa chave secreta. Confira os dois em Configurações do app → Básico.' }, 422);
      }
    }
    const saved = await rest.rpc('instagram_publisher_configure', { p_project_url: projectUrl,
      p_app_id: meta?.appId || null, p_app_secret: meta?.appSecret || null, p_config_id: meta?.configId || null,
      p_graph_version: meta?.version || null });
    return json({ ok: true, redirect_uri: redirectUri, meta_configured: saved.meta_configured });
  }

  const actions = {
    health: async () => json({ ok: true, redirect_uri: redirectUri, status: await rest.rpc('instagram_publisher_status') }),
    configure,
    connect: async body => json(...await connect.start(body)),
    resume: async body => json(...await connect.resume(body)),
    check: async body => json(...await (await publisherFor()).check(body.account)),
    test: async body => json(...await (await publisherFor()).test(body.post_id)),
    test_status: async body => json(...await (await publisherFor()).testStatus(body.post_id)),
    tick: async () => json(await (await publisherFor()).tick()),
  };

  async function command(request) {
    if (!keys.some(key => sameSecret(presentedKey(request), key))) {
      return json({ error: 'Não autorizado. Use a chave secreta do projeto (SUPABASE_SECRET_KEY no arquivo .env).' }, 401);
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'Solicitação muito grande.' }, 413);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json({ error: 'Solicitação inválida.' }, 400);
    }
    if (!Object.hasOwn(actions, body?.action || '')) return json({ error: 'Ação desconhecida.' }, 400);
    if (['test', 'test_status'].includes(body.action) && !UUID.test(body.post_id || '')) {
      return json({ error: 'Informe o id do post.' }, 400);
    }
    return actions[body.action](body);
  }

  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const params = url.searchParams;
        if (params.has('code') || params.has('state') || params.has('error')) return text(...await connect.callback(params));
        return text('Publicador de Instagram no ar.');
      }
      if (request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);
      const cron = request.headers.get('x-publicador-cron');
      if (cron) {
        const allowed = await rest.rpc('instagram_publisher_cron_ok', { p_secret: cron }).catch(() => false);
        return allowed === true ? actions.tick() : json({ error: 'Não autorizado.' }, 401);
      }
      return await command(request);
    } catch (error) {
      return failure(error);
    }
  };
}
