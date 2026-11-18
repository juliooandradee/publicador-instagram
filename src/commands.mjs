// Comandos da linha de comando. Cada um recebe as opções já lidas e o contexto (api, log, fuso, pasta temporária).
import crypto from 'node:crypto';
import path from 'node:path';
import { functionAnswer } from './api.mjs';
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, prepareImages, prepareVideo } from './media.mjs';
import { formatWhen, parseWhen } from './time.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KIND_LABEL = { image: 'foto', carousel: 'carrossel', reel: 'Reels' };
const STATE_LABEL = {
  draft: 'rascunho', scheduled: 'agendado', publishing: 'publicando', published: 'publicado', failed: 'falhou', cancelled: 'cancelado',
};
const LIMITS = { caption: 2200, hashtags: 30, mentions: 20 };
const RISKY_PHASES = new Set(['publishing', 'media_accepted', 'verification_pending']);
const MB = 1024 * 1024;

export const shortId = id => String(id).slice(0, 8);
export const normalizeHandle = handle => String(handle || '').trim().replace(/^@/, '').toLowerCase();

export function describePost(post, timeZone) {
  const when = post.published_at || post.scheduled_at;
  const parts = [shortId(post.id), KIND_LABEL[post.kind] || post.kind, STATE_LABEL[post.state] || post.state,
    when ? formatWhen(when, timeZone) : 'sem horário', `"${post.title}"`];
  let line = parts.join(' · ');
  if (post.permalink) line += `\n    ${post.permalink}`;
  if (post.last_error && post.state !== 'published') line += `\n    ${post.last_error}`;
  return line;
}

function describeAccount(account, timeZone) {
  if (!account.username) {
    const waiting = account.pending ? ' A Meta aprovou, mas falta escolher o Instagram: npm run conectar -- --retomar' : '';
    return `Instagram (conta ${account.account}): não conectado.${waiting}`;
  }
  const validity = account.expires_at ? `vale até ${formatWhen(account.expires_at, timeZone)}` : 'chave da Página, sem validade';
  return `Instagram (conta ${account.account}): @${account.username}, conectado em ${formatWhen(account.connected_at, timeZone)} (${validity}).`;
}

function describeQueue(queue, timeZone) {
  const lines = [`Fila: ${queue.scheduled} agendado(s), ${queue.failed} com falha.`];
  if (queue.next) lines.push(`Próximo: "${queue.next.title}" em ${formatWhen(queue.next.scheduled_at, timeZone)}.`);
  if (queue.last_published) lines.push(`Último publicado: ${queue.last_published.permalink}`);
  return lines.join(' ');
}

export async function statusCommand(ctx) {
  const status = await ctx.api.rpc('instagram_publisher_status');
  ctx.log(`Projeto: ${ctx.env.SUPABASE_URL}`);
  ctx.log(`App da Meta: ${status.meta_configured ? 'configurado.' : 'falta configurar (npm run configurar).'}`);
  ctx.log(`Agendador: ${status.scheduler_ready ? 'ativo, confere a fila a cada minuto.' : 'ainda não ativo (npm run configurar).'}`);
  if (!status.accounts.length) ctx.log('Instagram: nenhum conectado (npm run conectar -- --instagram @seuperfil).');
  for (const account of status.accounts) ctx.log(describeAccount(account, ctx.timeZone));
  ctx.log(describeQueue(status.queue, ctx.timeZone));
  return status;
}

function metaFromEnv(env) {
  const values = { app_id: env.META_APP_ID?.trim(), app_secret: env.META_APP_SECRET?.trim(), config_id: env.META_CONFIG_ID?.trim(),
    graph_version: env.META_GRAPH_VERSION?.trim() || 'v26.0' };
  if (!values.app_id && !values.config_id && !values.app_secret) return null;
  const missing = [['META_APP_ID', values.app_id], ['META_CONFIG_ID', values.config_id]].filter(([, value]) => !value);
  if (missing.length) throw new Error(`Falta preencher no .env: ${missing.map(([name]) => name).join(', ')}.`);
  return values;
}

export async function configureCommand(ctx) {
  const meta = metaFromEnv(ctx.env);
  const result = functionAnswer(await ctx.api.call('configure', meta || {}));
  ctx.log('A função publicador está no ar e o agendador foi ligado.');
  ctx.log(`Endereço de retorno para o app da Meta (copie igualzinho):\n  ${result.redirect_uri}`);
  if (!result.meta_configured) {
    ctx.log('Falta o app da Meta: preencha META_APP_ID, META_APP_SECRET e META_CONFIG_ID no .env e rode de novo.');
    return result;
  }
  ctx.log('O app da Meta foi conferido com a própria Meta e guardado no cofre (Vault) do seu Supabase.');
  if (ctx.env.META_APP_SECRET) {
    ctx.writeEnv('META_APP_SECRET', '');
    ctx.log('Tirei a chave secreta do arquivo .env: ela já está guardada no cofre.');
  }
  ctx.log('Próximo passo: npm run conectar -- --instagram @seuperfil');
  return result;
}

async function waitForConnection(ctx, account, since, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const status = await ctx.api.rpc('instagram_publisher_status');
    const found = status.accounts.find(item => item.account === account);
    if (found?.username && Date.parse(found.connected_at) >= since - 5000) return found;
    if (found?.pending_at && Date.parse(found.pending_at) >= since - 5000) {
      ctx.log('A Meta aprovou, mas o Instagram certo ainda não apareceu. Leia a mensagem na janela da Meta e depois rode: npm run conectar -- --retomar');
      return null;
    }
    await ctx.sleep(3000);
  }
  return null;
}

export async function connectCommand(options, ctx) {
  const account = options.account || 'principal';
  const expected = options.instagram ? normalizeHandle(options.instagram) : null;
  if (options.resume) {
    const result = functionAnswer(await ctx.api.call('resume', { account, expected_username: expected }));
    ctx.log(result.message || `Conectado: @${result.username}.`);
    return result;
  }
  const started = Date.now();
  const link = functionAnswer(await ctx.api.call('connect', { account, expected_username: expected }));
  ctx.log('Abra este link e autorize na tela oficial da Meta (vale 30 minutos):');
  ctx.log(link.url);
  if (!options.noBrowser) ctx.openUrl(link.url);
  ctx.log('Na Meta: entre com o Facebook que administra a Página ligada ao Instagram, marque essa Página e esse Instagram e salve.');
  const connected = await waitForConnection(ctx, account, started, options.wait ?? 90);
  if (!connected) {
    ctx.log('Ainda não vi a conexão. Quando terminar na Meta, rode: npm run status');
    return { connected: false, url: link.url };
  }
  ctx.log(`Conectado: @${connected.username} (conta ${connected.account}).`);
  await checkCommand({ account }, ctx).catch(error => ctx.log(`Não consegui conferir com a Meta agora: ${error.message}`));
  return { connected: true, username: connected.username };
}

export async function checkCommand(options, ctx) {
  const result = functionAnswer(await ctx.api.call('check', { account: options.account || 'principal' }));
  const posts = result.media_count != null ? `, com ${result.media_count} posts no perfil` : '';
  const quota = result.quota_total ? ` Cota das últimas 24 horas: ${result.quota_used ?? 0} de ${result.quota_total} publicações.` : '';
  ctx.log(`A Meta confirmou o acesso ao @${result.username}${posts}.${quota}`);
  return result;
}

export function readCaption(options, readFile) {
  const caption = options.captionFile ? readFile(options.captionFile) : options.caption;
  const text = String(caption ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('Informe a legenda com --legenda "..." ou --legenda-arquivo legenda.txt.');
  if (text.length > LIMITS.caption) throw new Error(`A legenda tem ${text.length} caracteres; o Instagram aceita até 2.200.`);
  const hashtags = text.match(/#[\p{L}\p{N}_]+/gu)?.length || 0;
  if (hashtags > LIMITS.hashtags) throw new Error(`A legenda tem ${hashtags} hashtags; o Instagram aceita até 30.`);
  const mentions = text.match(/@[A-Za-z0-9_.]+/g)?.length || 0;
  if (mentions > LIMITS.mentions) throw new Error(`A legenda marca ${mentions} perfis; o Instagram aceita até 20.`);
  return text;
}

export function prepareMedia(files, workDir, options = {}, tools = { prepareImages, prepareVideo }) {
  if (!files.length) throw new Error('Informe as imagens (de 1 a 10, na ordem do carrossel) ou um vídeo.');
  const extensions = files.map(file => path.extname(file).toLowerCase());
  if (extensions.every(extension => VIDEO_EXTENSIONS.has(extension))) {
    if (files.length !== 1) throw new Error('Envie um vídeo por vez: cada vídeo vira um Reels.');
    const video = tools.prepareVideo(files[0], workDir, { compress: options.compress });
    return { kind: 'reel', warnings: video.warnings,
      items: [{ file: video.file, contentType: 'video/mp4', name: 'video.mp4', bytes: video.bytes, info: video.info }] };
  }
  if (!extensions.every(extension => IMAGE_EXTENSIONS.has(extension))) {
    throw new Error('Use só imagens (JPG, PNG, WebP ou HEIC) ou um vídeo (MP4 ou MOV). Carrossel com vídeo ainda não é suportado.');
  }
  if (files.length > 10) throw new Error('O carrossel aceita até 10 imagens.');
  const { images, warnings } = tools.prepareImages(files, workDir);
  return { kind: images.length === 1 ? 'image' : 'carousel', warnings,
    items: images.map((image, index) => ({ file: image.file, contentType: 'image/jpeg',
      name: `${String(index + 1).padStart(2, '0')}.jpg`, width: image.width, height: image.height, bytes: image.bytes })) };
}

function describeUpload(item, index) {
  if (item.contentType === 'video/mp4') {
    const info = item.info ? `${item.info.width} × ${item.info.height}, ${Math.round(item.info.seconds)} s, ` : '';
    return `Vídeo enviado ao seu Supabase: ${info}${(item.bytes / MB).toFixed(1)} MB.`;
  }
  return `Imagem ${index + 1} enviada: ${item.width} × ${item.height}, ${Math.round(item.bytes / 1024)} KB.`;
}

async function requireConnected(ctx, account) {
  const status = await ctx.api.rpc('instagram_publisher_status');
  const found = status.accounts.find(item => item.account === account);
  if (!found?.username) throw new Error(`O Instagram da conta "${account}" não está conectado. Rode: npm run conectar -- --instagram @seuperfil`);
  if (found.expires_at && Date.parse(found.expires_at) <= Date.now()) throw new Error('A conexão com o Instagram venceu. Rode: npm run conectar');
  return found;
}

const defaultTitle = caption => caption.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 60) || 'Post';

export async function publishCommand(options, ctx) {
  const caption = readCaption(options, ctx.readFile);
  const when = options.now || !options.when ? null : parseWhen(options.when, ctx.timeZone);
  const account = options.account || 'principal';
  await requireConnected(ctx, account);
  const prepared = prepareMedia(options.files, ctx.workDir, options, ctx.mediaTools);
  for (const warning of prepared.warnings) ctx.log(`Aviso: ${warning}`);
  const postId = crypto.randomUUID();
  const media = [];
  for (const [index, item] of prepared.items.entries()) {
    await ctx.api.upload(`${postId}/${item.name}`, item.file, item.contentType);
    ctx.log(describeUpload(item, index));
    media.push({ path: `${postId}/${item.name}` });
  }
  const title = (options.title || defaultTitle(caption)).slice(0, 160);
  const post = await ctx.api.rpc('instagram_publisher_create_post', { p_post: postId, p_account_key: account,
    p_kind: prepared.kind, p_title: title, p_caption: caption, p_media: media });
  ctx.log(`Post criado: ${shortId(postId)} · ${KIND_LABEL[prepared.kind]} · "${title}" · rascunho.`);
  let result = post;
  if (options.test) result = { ...result, test: await testCommand({ id: postId }, ctx) };
  if (when || options.now) result = await scheduleCommand({ id: postId, whenDate: when, now: options.now, wait: options.wait }, ctx);
  else ctx.log(`Para agendar: npm run agendar -- ${shortId(postId)} --quando "AAAA-MM-DD HH:MM"`);
  return result;
}

export async function resolvePostId(ctx, text) {
  const value = String(text || '').trim().toLowerCase();
  if (UUID.test(value)) return value;
  if (!/^[0-9a-f-]{4,}$/.test(value)) throw new Error('Informe o id do post (os 8 primeiros caracteres bastam; veja em npm run fila).');
  const posts = await ctx.api.rpc('instagram_publisher_list', { p_limit: 100 });
  const matches = posts.filter(post => post.id.startsWith(value));
  if (matches.length === 1) return matches[0].id;
  throw new Error(matches.length ? 'Mais de um post começa com esse id; use mais caracteres.' : 'Não achei post com esse id (veja em npm run fila).');
}

export async function testCommand(options, ctx) {
  const id = await resolvePostId(ctx, options.id);
  let data = functionAnswer(await ctx.api.call(options.statusOnly ? 'test_status' : 'test', { post_id: id }));
  for (let check = 0; data.state === 'processing' && check < 18; check++) {
    ctx.log(data.message);
    await ctx.sleep(10000);
    data = functionAnswer(await ctx.api.call('test_status', { post_id: id }));
  }
  if (data.state === 'processing') ctx.log(`Ainda processando. Confira depois com: npm run testar -- ${shortId(id)} --status`);
  else ctx.log(`Teste: ${data.message}`);
  return data;
}

async function publishNow(ctx, id, seconds) {
  await ctx.api.call('tick').catch(() => null);
  const deadline = Date.now() + seconds * 1000;
  let post = await ctx.api.rpc('instagram_publisher_get', { p_post: id });
  while (['scheduled', 'publishing'].includes(post.state) && Date.now() < deadline) {
    await ctx.sleep(10000);
    post = await ctx.api.rpc('instagram_publisher_get', { p_post: id });
  }
  if (post.state === 'published') ctx.log(`Publicado no @${post.username}: ${post.permalink}`);
  else if (post.state === 'failed') throw new Error(post.last_error || 'O Instagram recusou a publicação.');
  else ctx.log(`Ainda não saiu${post.last_error ? ` (${post.last_error})` : ''}. O publicador tenta sozinho a cada minuto; confira com: npm run fila`);
  return post;
}

export async function scheduleCommand(options, ctx) {
  const id = await resolvePostId(ctx, options.id);
  const when = options.whenDate || (options.now ? new Date() : parseWhen(options.when, ctx.timeZone));
  const post = await ctx.api.rpc('instagram_publisher_schedule', { p_post: id, p_when: when.toISOString() });
  if (options.now) {
    ctx.log(`Publicando agora no @${post.username}...`);
    return publishNow(ctx, id, options.wait ?? 150);
  }
  ctx.log(`Agendado: "${post.title}" sai sozinho em ${formatWhen(post.scheduled_at, ctx.timeZone)} no @${post.username}.`);
  ctx.log('Pode desligar o computador: quem publica no horário é o seu Supabase.');
  return post;
}

export async function cancelCommand(options, ctx) {
  const id = await resolvePostId(ctx, options.id);
  const post = await ctx.api.rpc('instagram_publisher_cancel', { p_post: id });
  ctx.log(`Cancelado: "${post.title}". Ele fica na lista e pode ser agendado de novo.`);
  if (RISKY_PHASES.has(post.phase)) ctx.log('Atenção: o Instagram pode já ter recebido este post. Confira o perfil.');
  return post;
}

export async function queueCommand(options, ctx) {
  const posts = await ctx.api.rpc('instagram_publisher_list', { p_limit: Number(options.limit) || 20 });
  if (!posts.length) ctx.log('Nenhum post ainda. Para começar: npm run publicar -- --legenda "..." imagem.jpg');
  for (const post of posts) ctx.log(describePost(post, ctx.timeZone));
  return posts;
}

export async function disconnectCommand(options, ctx) {
  if (!options.yes) throw new Error('Isto desliga a publicação neste Instagram. Para confirmar, rode de novo com --sim.');
  const result = await ctx.api.rpc('instagram_publisher_disconnect', { p_account_key: options.account || 'principal' });
  ctx.log(result.username ? `Desconectado: @${result.username}. A chave foi apagada do cofre.` : 'Esta conta já estava desconectada.');
  ctx.log('Para tirar o acesso também do lado da Meta: no Facebook, em Integrações comerciais, remova o app.');
  return result;
}

export async function cleanCommand(ctx) {
  const pending = await ctx.api.rpc('instagram_publisher_media_to_remove', { p_limit: 200 });
  for (const item of pending) {
    await ctx.api.remove(item.media.map(media => media.path));
    await ctx.api.rpc('instagram_publisher_media_removed', { p_post: item.post_id });
  }
  ctx.log(pending.length ? `Apaguei do armazenamento as mídias de ${pending.length} post(s) já publicados.`
    : 'Nada para limpar: as mídias dos posts publicados já foram apagadas.');
  return { removed: pending.length };
}
