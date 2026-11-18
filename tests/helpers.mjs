// Supabase e Meta de mentira para os testes: nenhuma chamada sai do computador.
export const PROJECT = 'https://projeto-teste.supabase.co';
export const NEW_KEY = 'sb_secret_chave_nova_de_teste_1234567890';
export const LEGACY_KEY = 'eyJhbGciOiJIUzI1NiJ9.chave_antiga_de_teste.assinatura';
export const CRON_SECRET = 'c'.repeat(64);
export const POST = '11111111-1111-4111-8111-111111111111';
export const IG = '17841400000000001';
export const TOKEN = 'chave-da-pagina-de-teste-0123456789';

export const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

export function job(extra = {}) {
  return {
    post_id: POST, lease_id: '22222222-2222-4222-8222-222222222222', account_id: '33333333-3333-4333-8333-333333333333',
    kind: 'carousel', attempt: 1, media: [{ path: `${POST}/01.jpg` }, { path: `${POST}/02.jpg` }], children: null,
    container_id: null, media_id: null, caption: 'Comente GUIA que eu te mando', scheduled_at: '2026-11-18T12:00:00Z',
    ig_user_id: IG, username: 'consultorio.exemplo', token: TOKEN, ...extra,
  };
}

// meta.status: status_code dos containers; meta.fail[caminho]: resposta de erro; meta.recent: posts recentes do perfil.
function metaAnswer(url, method, body, meta, calls) {
  const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
  if (meta.fail?.[path]) return meta.fail[path]();
  if (path === '/oauth/access_token') return json({ access_token: body?.code ? 'chave-de-usuario-curta-0123456789' : 'chave-de-usuario-longa-0123456789' });
  if (path === '/debug_token') return json({ data: meta.debug || { is_valid: true, app_id: '1234567890', type: 'USER', expires_at: 0, scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list'] } });
  if (path === '/me/accounts') return json({ data: meta.pages ?? [{ id: '500', access_token: TOKEN, instagram_business_account: { id: IG, username: 'consultorio.exemplo' } }] });
  if (path === '/me/assigned_instagram_accounts') return json({ data: [] });
  if (path.endsWith('/media_publish')) return json({ id: '900' });
  if (path.endsWith('/media') && method === 'POST') {
    const created = calls.filter(call => call.url.pathname.endsWith('/media') && call.method === 'POST').length;
    return json({ id: `${created}0` });
  }
  if (path.endsWith('/media')) return json({ data: meta.recent || [] });
  if (path.endsWith('/content_publishing_limit')) return json({ data: [{ quota_usage: 2, config: { quota_total: 100 } }] });
  if (path === '/900') return json({ id: '900', permalink: 'https://www.instagram.com/p/abc/', timestamp: '2026-11-18T12:01:00+0000' });
  if (path === `/${IG}`) return json({ id: IG, username: 'consultorio.exemplo', media_count: 321 });
  return json({ id: path.slice(1), status_code: meta.status || 'FINISHED' });
}

export function fakeWorld({ rpc = {}, meta = {} } = {}) {
  const calls = [];
  const fetcher = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || 'GET';
    let body = null;
    if (options.body instanceof URLSearchParams) body = Object.fromEntries(options.body);
    else if (typeof options.body === 'string') body = JSON.parse(options.body);
    calls.push({ url, method, headers: options.headers || {}, body });
    if (url.hostname === 'graph.facebook.com') {
      return metaAnswer(url, method, method === 'GET' ? Object.fromEntries(url.searchParams) : body, meta, calls);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      const result = rpc[name] ? await rpc[name](body) : true;
      return result instanceof Response ? result : json(result);
    }
    if (url.pathname.startsWith('/storage/v1/object/sign/')) {
      return json({ signedURL: `${url.pathname.replace('/storage/v1', '')}?token=assinado` });
    }
    if (url.pathname.startsWith('/storage/v1/object/')) return json({ Key: url.pathname });
    return json({ error: 'endereço inesperado no teste' }, 500);
  };
  const named = name => calls.filter(call => call.url.pathname === `/rest/v1/rpc/${name}`);
  const metaCalls = () => calls.filter(call => call.url.hostname === 'graph.facebook.com');
  return { fetcher, calls, named, metaCalls };
}

export const dbError = message => json({ code: 'P0001', message }, 400);
