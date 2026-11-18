import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHandler } from '../supabase/functions/publicador/handler.mjs';
import { chooseAccount, pickAccount } from '../supabase/functions/_shared/connect.mjs';
import { loginDialogUrl } from '../supabase/functions/_shared/graph.mjs';
import { IG, NEW_KEY, PROJECT, TOKEN, fakeWorld } from './helpers.mjs';

const META_CONFIG = { app_id: '1234567890', app_secret: 'ab'.repeat(16), config_id: '9876543210', graph_version: 'v26.0' };
const STATE = 'a'.repeat(64);
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

function rig({ meta = {}, rpc = {}, pending = { account_id: ACCOUNT_ID, account: 'principal', expected_username: 'consultorio.exemplo' } } = {}) {
  const world = fakeWorld({ meta, rpc: {
    instagram_publisher_meta_config: () => META_CONFIG,
    instagram_publisher_oauth_begin: body => ({ state: STATE, account: body.p_account_key, expected_username: body.p_expected_username }),
    instagram_publisher_oauth_consume: body => (body.p_state === STATE ? pending : null),
    instagram_publisher_save_connection: () => ({ account: 'principal', username: 'consultorio.exemplo' }),
    ...rpc,
  } });
  const handler = makeHandler({ env: { SUPABASE_URL: PROJECT, SUPABASE_SECRET_KEYS: JSON.stringify({ default: NEW_KEY }) },
    fetcher: world.fetcher, sleep: async () => {} });
  const back = query => handler(new Request(`${PROJECT}/functions/v1/publicador?${query}`));
  const command = body => handler(new Request(`${PROJECT}/functions/v1/publicador`, { method: 'POST', headers: { apikey: NEW_KEY }, body: JSON.stringify(body) }));
  return { ...world, back, command };
}

test('o link de conexão vai para a tela oficial da Meta com o app, a configuração e o endereço de retorno', async () => {
  const r = rig();
  const data = await (await r.command({ action: 'connect', account: 'principal', expected_username: 'consultorio.exemplo' })).json();
  const url = new URL(data.url);
  assert.equal(url.origin + url.pathname, 'https://www.facebook.com/dialog/oauth');
  assert.equal(url.searchParams.get('client_id'), '1234567890');
  assert.equal(url.searchParams.get('config_id'), '9876543210');
  assert.equal(url.searchParams.get('redirect_uri'), `${PROJECT}/functions/v1/publicador`);
  assert.equal(url.searchParams.get('state'), STATE);
  assert.ok(!data.url.includes(META_CONFIG.app_secret), 'a chave secreta não pode ir no link');
});

test('a volta da Meta salva a chave da Página (que não vence) e responde em texto', async () => {
  const r = rig();
  const response = await r.back(`code=codigo-da-meta&state=${STATE}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.match(await response.text(), /@consultorio\.exemplo está conectado/);
  const saved = r.named('instagram_publisher_save_connection')[0].body;
  assert.equal(saved.p_token, TOKEN);
  assert.equal(saved.p_ig_user_id, IG);
  assert.equal(saved.p_expires_at, null);
  const exchange = r.metaCalls().find(call => call.url.searchParams.get('code') === 'codigo-da-meta');
  assert.equal(exchange.url.searchParams.get('redirect_uri'), `${PROJECT}/functions/v1/publicador`);
});

test('pedido expirado ou repetido não troca o código na Meta', async () => {
  const r = rig();
  const response = await r.back(`code=codigo&state=${'b'.repeat(64)}`);
  assert.equal(response.status, 410);
  assert.match(await response.text(), /expirou/);
  assert.equal(r.metaCalls().length, 0);
});

test('cancelar na tela da Meta não grava nada', async () => {
  const r = rig();
  assert.match(await (await r.back('error=access_denied&state=x')).text(), /cancelou/);
  assert.equal(r.named('instagram_publisher_save_connection').length, 0);
});

test('sem Instagram compartilhado, a chave espera para retomar sem novo login', async () => {
  const r = rig({ meta: { pages: [] } });
  const response = await r.back(`code=codigo&state=${STATE}`);
  assert.equal(response.status, 409);
  assert.match(await response.text(), /--retomar/);
  assert.equal(r.named('instagram_publisher_keep_pending').length, 1);
  assert.equal(r.named('instagram_publisher_save_connection').length, 0);
});

test('retomar escolhendo o @ certo entre vários Instagrams', async () => {
  const pages = [
    { id: '501', access_token: 'chave-pagina-clinica-0123456789', instagram_business_account: { id: '17841400000000002', username: 'clinica.exemplo' } },
    { id: '500', access_token: TOKEN, instagram_business_account: { id: IG, username: 'consultorio.exemplo' } },
  ];
  const r = rig({ meta: { pages }, rpc: { instagram_publisher_take_pending: body => ({ account_id: ACCOUNT_ID, account: 'principal',
    expected_username: body.p_expected_username, token: 'chave-de-usuario-longa-0123456789', scopes: [] }) } });
  const data = await (await r.command({ action: 'resume', account: 'principal', expected_username: 'clinica.exemplo' })).json();
  assert.equal(data.username, 'clinica.exemplo');
  assert.equal(r.named('instagram_publisher_save_connection')[0].body.p_token, 'chave-pagina-clinica-0123456789');
});

test('escolha do Instagram: @ esperado, um só disponível ou ambíguo', () => {
  const accounts = [{ id: '1', username: 'Consultorio.Exemplo' }, { id: '2', username: 'outra' }];
  assert.equal(pickAccount(accounts, 'consultorio.exemplo').id, '1');
  assert.equal(pickAccount([accounts[1]], null).id, '2');
  assert.equal(pickAccount(accounts, null), null);
  assert.equal(chooseAccount({ accounts }, null).code, 'varias-contas');
  assert.equal(chooseAccount({ accounts }, 'nao.existe').code, 'outra-conta');
  assert.equal(chooseAccount({ accounts: [] }, null).code, 'sem-conta');
});

test('o diálogo de login leva só identificadores públicos', () => {
  const url = new URL(loginDialogUrl({ appId: '1', configId: '2', redirectUri: 'https://x.supabase.co/functions/v1/publicador', state: 's' }));
  assert.deepEqual([...url.searchParams.keys()].sort(),
    ['client_id', 'config_id', 'override_default_response_type', 'prompt', 'redirect_uri', 'response_type', 'state']);
});
