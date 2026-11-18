import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHandler } from '../supabase/functions/publicador/handler.mjs';
import { friendlyError } from '../supabase/functions/_shared/publish.mjs';
import { MetaError } from '../supabase/functions/_shared/graph.mjs';
import { CRON_SECRET, IG, LEGACY_KEY, NEW_KEY, POST, PROJECT, TOKEN, dbError, fakeWorld, job, json } from './helpers.mjs';

const META_CONFIG = { app_id: '1234567890', app_secret: 'ab'.repeat(16), config_id: '9876543210', graph_version: 'v26.0' };

function rig({ jobs = [], checkpoint = true, meta = {}, rpc = {}, env = {} } = {}) {
  const queue = [...jobs];
  const world = fakeWorld({ meta, rpc: {
    instagram_publisher_cron_ok: body => body.p_secret === CRON_SECRET,
    instagram_publisher_meta_config: () => META_CONFIG,
    instagram_publisher_claim: () => queue.shift() || null,
    instagram_publisher_checkpoint: body => (typeof checkpoint === 'function' ? checkpoint(body) : checkpoint),
    ...rpc,
  } });
  const handler = makeHandler({ env: { SUPABASE_URL: PROJECT, SUPABASE_SECRET_KEYS: JSON.stringify({ default: NEW_KEY }),
    SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY, ...env }, fetcher: world.fetcher, sleep: async () => {}, pollMs: 0 });
  const cron = (secret = CRON_SECRET) => handler(new Request(`${PROJECT}/functions/v1/publicador`,
    { method: 'POST', headers: { 'x-publicador-cron': secret }, body: '{"action":"tick"}' }));
  const command = (body, headers = { apikey: NEW_KEY }) => handler(new Request(`${PROJECT}/functions/v1/publicador`,
    { method: 'POST', headers, body: JSON.stringify(body) }));
  const finished = () => world.named('instagram_publisher_finish').map(call => call.body);
  return { ...world, handler, cron, command, finished };
}

test('o agendador sem o segredo certo não processa nada', async () => {
  const r = rig({ jobs: [job()] });
  assert.equal((await r.cron('errado')).status, 401);
  assert.equal(r.named('instagram_publisher_claim').length, 0);
});

test('publica o carrossel na ordem, grava o link e apaga as mídias do bucket', async () => {
  const r = rig({ jobs: [job()] });
  assert.deepEqual((await (await r.cron()).json()).processed, ['published']);
  const children = r.metaCalls().filter(call => call.method === 'POST' && call.body.is_carousel_item);
  assert.equal(children.length, 2);
  assert.ok(children.every(call => call.body.image_url.startsWith(`${PROJECT}/storage/v1/object/sign/instagram-publisher/${POST}/`)));
  assert.ok(r.metaCalls().every(call => call.headers.Authorization === `Bearer ${TOKEN}` && !call.url.href.includes(TOKEN)));
  const carousel = r.metaCalls().find(call => call.body?.media_type === 'CAROUSEL');
  assert.equal(carousel.body.children, '10,20');
  assert.equal(carousel.body.caption, 'Comente GUIA que eu te mando');
  assert.deepEqual(r.named('instagram_publisher_checkpoint').map(call => call.body.p_patch.phase),
    ['children_created', 'container_created', 'publishing', 'media_accepted']);
  const [done] = r.finished();
  assert.equal(done.p_state, 'published');
  assert.equal(done.p_patch.permalink, 'https://www.instagram.com/p/abc/');
  const removal = r.calls.find(call => call.method === 'DELETE');
  assert.deepEqual(removal.body.prefixes, [`${POST}/01.jpg`, `${POST}/02.jpg`]);
  assert.equal(r.named('instagram_publisher_media_removed').length, 1);
  // A função fala com o banco usando a chave nova, só no cabeçalho apikey.
  const rpcCall = r.named('instagram_publisher_claim')[0];
  assert.equal(rpcCall.headers.apikey, NEW_KEY);
  assert.equal(rpcCall.headers.Authorization, undefined);
});

test('foto única leva a legenda no próprio container, sem marcar como item de carrossel', async () => {
  const r = rig({ jobs: [job({ kind: 'image', media: [{ path: `${POST}/01.jpg` }] })] });
  await r.cron();
  const creations = r.metaCalls().filter(call => call.method === 'POST' && call.url.pathname.endsWith('/media'));
  assert.equal(creations.length, 1);
  assert.equal(creations[0].body.caption, 'Comente GUIA que eu te mando');
  assert.equal(creations[0].body.is_carousel_item, undefined);
  assert.equal(r.finished()[0].p_state, 'published');
});

test('Reels ainda processando volta para a fila guardando o container, sem publicar', async () => {
  const r = rig({ jobs: [job({ kind: 'reel', media: [{ path: `${POST}/video.mp4` }] })], meta: { status: 'IN_PROGRESS' } });
  await r.cron();
  const reel = r.metaCalls().find(call => call.body?.media_type === 'REELS');
  assert.equal(reel.body.share_to_feed, 'true');
  assert.ok(reel.body.video_url.includes(`${POST}/video.mp4`));
  assert.ok(!r.metaCalls().some(call => call.url.pathname.endsWith('/media_publish')));
  const [retry] = r.finished();
  assert.equal(retry.p_state, 'retry');
  assert.equal(retry.p_patch.phase, 'container_processing');
  assert.equal(r.named('instagram_publisher_checkpoint')[0].body.p_patch.container_id, '10');
});

test('retomada: container já publicado é confirmado pela legenda, sem publicar de novo', async () => {
  const recent = [{ id: '800', caption: ' Comente GUIA que eu te mando ', permalink: 'https://www.instagram.com/p/xyz/', timestamp: '2026-11-18T12:00:30Z' }];
  const r = rig({ jobs: [job({ container_id: '333' })], meta: { status: 'PUBLISHED', recent } });
  await r.cron();
  assert.ok(!r.metaCalls().some(call => call.method === 'POST'));
  assert.equal(r.finished()[0].p_patch.media_id, '800');
});

test('retomada: container pronto é publicado uma vez, sem recriar as imagens', async () => {
  const r = rig({ jobs: [job({ container_id: '333' })] });
  await r.cron();
  const posts = r.metaCalls().filter(call => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.creation_id, '333');
});

test('publicação sem resposta da Meta vira nova tentativa com espera crescente, nunca falha às cegas', async () => {
  const r = rig({ jobs: [job({ container_id: '333', attempt: 3 })], meta: { fail: { [`/${IG}/media_publish`]: () => json({ error: { code: 1 } }, 503) } } });
  await r.cron();
  const [retry] = r.finished();
  assert.equal(retry.p_state, 'retry');
  assert.equal(retry.p_patch.retry_in_seconds, 480);
});

test('limite de publicações da Meta espera 30 minutos; chave vencida falha pedindo nova conexão', () => {
  assert.equal(friendlyError(new MetaError('x', { code: 4, status: 400 })).retry, 1800);
  assert.match(friendlyError(new MetaError('x', { code: 190, status: 400 })).error, /npm run conectar/);
  assert.equal(friendlyError(new MetaError('x', { code: 100, status: 400, detail: 'Invalid parameter' })).state, 'failed');
  assert.match(friendlyError(new MetaError('x', { code: 100, status: 400, detail: 'Invalid parameter' })).error, /Invalid parameter/);
});

test('se a reserva expira no meio, para antes de publicar', async () => {
  const r = rig({ jobs: [job()], checkpoint: body => body.p_patch.phase !== 'publishing' });
  assert.deepEqual((await (await r.cron()).json()).processed, ['cancelled']);
  assert.ok(!r.metaCalls().some(call => call.url.pathname.endsWith('/media_publish')));
});

test('comandos exigem a chave secreta do projeto (nova no apikey ou antiga no Authorization)', async () => {
  const r = rig({ rpc: { instagram_publisher_status: () => ({ accounts: [] }) } });
  assert.equal((await r.command({ action: 'health' }, { apikey: 'sb_secret_outra_chave_qualquer_1234567' })).status, 401);
  assert.equal((await r.command({ action: 'health' }, {})).status, 401);
  assert.equal((await r.command({ action: 'health' })).status, 200);
  assert.equal((await r.command({ action: 'health' }, { authorization: `Bearer ${LEGACY_KEY}` })).status, 200);
  const health = await (await r.command({ action: 'health' })).json();
  assert.equal(health.redirect_uri, `${PROJECT}/functions/v1/publicador`);
  assert.equal((await r.command({ action: 'apagar_tudo' })).status, 400);
});

test('configurar confere o app com a Meta antes de guardar e devolve o endereço de retorno', async () => {
  const r = rig({ rpc: { instagram_publisher_configure: () => ({ meta_configured: true }) } });
  const response = await r.command({ action: 'configure', app_id: '1234567890', app_secret: 'cd'.repeat(16), config_id: '555666777', graph_version: 'v26.0' });
  assert.equal(response.status, 200);
  const check = r.metaCalls().find(call => call.url.searchParams.get('grant_type') === 'client_credentials');
  assert.equal(check.url.searchParams.get('client_id'), '1234567890');
  const saved = r.named('instagram_publisher_configure')[0].body;
  assert.equal(saved.p_project_url, PROJECT);
  assert.equal(saved.p_app_secret, 'cd'.repeat(16));
});

test('configurar recusa app que a Meta não reconhece e não guarda nada', async () => {
  const r = rig({ meta: { fail: { '/oauth/access_token': () => json({ error: { code: 101, message: 'Error validating client secret.' } }, 400) } } });
  const response = await r.command({ action: 'configure', app_id: '1234567890', app_secret: 'cd'.repeat(16), config_id: '555666777' });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /não reconheceu/);
  assert.equal(r.named('instagram_publisher_configure').length, 0);
});

test('testar sem publicar monta o post e para antes do media_publish', async () => {
  const context = { post_id: POST, kind: 'carousel', media: job().media, caption: 'Legenda', ig_user_id: IG, username: 'consultorio.exemplo', token: TOKEN };
  const r = rig({ rpc: { instagram_publisher_test_context: () => context } });
  const response = await r.command({ action: 'test', post_id: POST });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.state, 'ok');
  assert.match(data.message, /aceitou as 2 imagens e a legenda\. Nada foi publicado\./);
  assert.ok(!r.metaCalls().some(call => call.url.pathname.endsWith('/media_publish')));
  assert.equal(r.named('instagram_publisher_test_record')[0].body.p_container_id, '30');
});

test('testar avisa quando o Instagram não está conectado', async () => {
  const r = rig({ rpc: { instagram_publisher_test_context: () => dbError('not_connected') } });
  const response = await r.command({ action: 'test', post_id: POST });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /npm run conectar/);
});

test('GET sem parâmetros responde que está no ar, em texto simples', async () => {
  const r = rig();
  const response = await r.handler(new Request(`${PROJECT}/functions/v1/publicador`));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'Publicador de Instagram no ar.');
});
