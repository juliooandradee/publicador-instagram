// Fila de publicação: monta o post no Instagram, espera o processamento, publica e grava o link.
// Nunca publica duas vezes: cada fase fica registrada no banco antes da próxima chamada à Meta.
import { InstagramClient, MetaError } from './graph.mjs';

const EXPIRED_TOKEN = 190;
const RATE_LIMITS = new Set([4, 17, 32, 613, 2207042]);
const LINK_SECONDS = 3600;
const KIND_TEXT = {
  image: () => 'a imagem e a legenda',
  carousel: count => `as ${count} imagens e a legenda`,
  reel: () => 'o vídeo e a legenda',
};
// Erros da Meta que a pessoa consegue resolver. Limite de publicações volta para a fila em vez de falhar.
const META_MESSAGES = {
  9004: 'O Instagram não conseguiu baixar a mídia. Envie de novo e agende outra vez.',
  2207052: 'O Instagram não conseguiu baixar a mídia. Envie de novo e agende outra vez.',
  36003: 'O Instagram recusou a proporção da imagem. Use de 4:5 (vertical) a 1,91:1 (horizontal).',
  2207026: 'O Instagram recusou o formato da mídia. Use JPEG nas imagens e MP4 (H.264 e AAC) no vídeo.',
  2207009: 'O Instagram recusou a proporção da imagem. Use de 4:5 (vertical) a 1,91:1 (horizontal).',
};

const containerRefusal = kind => (kind === 'reel'
  ? 'O Instagram não aceitou o vídeo. Confira o formato (MP4, H.264 e AAC, vertical) e agende outra vez.'
  : 'O Instagram não aceitou as imagens. Envie de novo e agende outra vez.');

export function friendlyError(error) {
  if (error?.code === EXPIRED_TOKEN) {
    return { state: 'failed', error: 'A conexão com o Instagram expirou ou foi removida. Conecte de novo (npm run conectar) e agende outra vez.' };
  }
  if (RATE_LIMITS.has(error?.code) || RATE_LIMITS.has(error?.subcode)) {
    return { state: 'retry', retry: 1800, error: 'O Instagram pediu uma pausa nas publicações. Nova tentativa automática em 30 minutos.' };
  }
  if (error?.uncertain || error?.status >= 500 || (error instanceof MetaError && !error.status && !error.code)) {
    return { state: 'retry', backoff: true, error: 'O Instagram não respondeu. Nova tentativa automática em instantes.' };
  }
  const message = META_MESSAGES[error?.code] || META_MESSAGES[error?.subcode];
  if (message) return { state: 'failed', error: message };
  if (!error?.code) return { state: 'failed', error: 'Não foi possível publicar este post. Revise e agende de novo.' };
  const detail = error.detail ? ` A Meta disse: "${error.detail}"` : '';
  return { state: 'failed', error: `O Instagram recusou a publicação (código ${error.code}).${detail}`.slice(0, 500) };
}

export function makePublisher({ rest, version, mediaHost, fetcher = fetch, sleep = ms => new Promise(done => setTimeout(done, ms)),
  budgetMs = 100000, pollMs = 3000 }) {
  const client = token => new InstagramClient({ token, version, fetchImpl: fetcher, mediaHosts: [mediaHost] });
  const pathsOf = post => post.media.map(item => item.path);

  // Imagem sai em segundos; vídeo pode levar alguns minutos e continua na próxima rodada.
  async function waitFinished(ig, containerId, kind) {
    const tries = kind === 'reel' ? 12 : 8;
    const wait = kind === 'reel' ? pollMs * 2 : pollMs;
    let answer = { status_code: 'IN_PROGRESS' };
    for (let attempt = 0; attempt < tries; attempt++) {
      answer = await ig.status(containerId);
      if (answer.status_code !== 'IN_PROGRESS') return answer;
      await sleep(wait);
    }
    return answer;
  }

  async function createContainer(ig, post, checkpoint = async () => true) {
    const paths = pathsOf(post);
    if (post.kind === 'carousel') {
      const urls = [];
      for (const path of paths) urls.push(await rest.sign(path, LINK_SECONDS));
      const children = [];
      for (const url of urls) children.push((await ig.image(post.ig_user_id, url, { carouselItem: true })).id);
      if (!await checkpoint({ phase: 'children_created', children })) return null;
      const container = (await ig.carousel(post.ig_user_id, children, post.caption)).id;
      return (await checkpoint({ phase: 'container_created', container_id: container })) ? container : null;
    }
    const url = await rest.sign(paths[0], LINK_SECONDS);
    const created = post.kind === 'reel'
      ? await ig.reel(post.ig_user_id, url, post.caption)
      : await ig.image(post.ig_user_id, url, { caption: post.caption });
    return (await checkpoint({ phase: 'container_created', container_id: created.id })) ? created.id : null;
  }

  // Depois de uma publicação sem confirmação, a legenda e a data identificam o post. Este caminho nunca publica.
  async function findPublished(ig, job) {
    const recent = (await ig.recentMedia(job.ig_user_id)).data || [];
    const since = Date.parse(job.scheduled_at || new Date(Date.now() - 3600000).toISOString()) - 300000;
    const matches = recent.filter(item => (item.caption || '').trim() === (job.caption || '').trim()
      && item.permalink && item.timestamp && Date.parse(item.timestamp) >= since);
    return matches.length === 1 ? matches[0] : null;
  }

  async function removeMedia(job) {
    try {
      await rest.remove(pathsOf(job));
      await rest.rpc('instagram_publisher_media_removed', { p_post: job.post_id });
    } catch {
      // Fica para o comando "limpar".
    }
  }

  async function publishJob(job) {
    const ig = client(job.token);
    const checkpoint = async patch => (await rest.rpc('instagram_publisher_checkpoint',
      { p_post: job.post_id, p_lease: job.lease_id, p_patch: patch })) === true;
    const finish = (state, patch = {}) => rest.rpc('instagram_publisher_finish',
      { p_post: job.post_id, p_lease: job.lease_id, p_state: state, p_patch: patch });
    const done = async media => {
      if (!media.id || !media.permalink) {
        await finish('retry', { phase: 'verification_pending', retry_in_seconds: 60 });
        return 'retry';
      }
      const saved = await finish('published', { phase: 'published', media_id: media.id, permalink: media.permalink,
        ...(media.timestamp ? { published_at: new Date(media.timestamp).toISOString() } : {}) });
      if (saved) await removeMedia(job);
      return 'published';
    };
    try {
      return await advance(ig, job, { checkpoint, finish, done });
    } catch (error) {
      return recordFailure(job, finish, error);
    }
  }

  async function advance(ig, job, { checkpoint, finish, done }) {
    if (job.media_id) return done(await ig.media(job.media_id));
    let container = job.container_id;
    if (container) {
      const status = (await ig.status(container)).status_code;
      if (status === 'PUBLISHED') {
        const media = await findPublished(ig, job);
        if (media) return done(media);
        await finish('retry', { phase: 'verification_pending', retry_in_seconds: 120,
          error: 'O Instagram processou a publicação. Aguardando a confirmação do link, sem publicar de novo.' });
        return 'retry';
      }
      if (status === 'IN_PROGRESS') return retryProcessing(finish);
      if (status !== 'FINISHED') container = null;
    }
    if (!container) {
      container = await createContainer(ig, job, checkpoint);
      if (!container) return 'cancelled';
      const { status_code: status } = await waitFinished(ig, container, job.kind);
      if (status === 'IN_PROGRESS') return retryProcessing(finish);
      if (status !== 'FINISHED') {
        await finish('failed', { phase: 'container_error', container_id: null, children: null, error: containerRefusal(job.kind) });
        return 'failed';
      }
    }
    if (!await checkpoint({ phase: 'publishing' })) return 'cancelled';
    const media = await ig.publish(job.ig_user_id, container);
    await checkpoint({ phase: 'media_accepted', media_id: media.id });
    return done(await ig.media(media.id));
  }

  async function retryProcessing(finish) {
    await finish('retry', { phase: 'container_processing', retry_in_seconds: 60 });
    return 'retry';
  }

  async function recordFailure(job, finish, error) {
    const outcome = friendlyError(error);
    const seconds = outcome.backoff ? 60 * 2 ** Math.min(job.attempt || 1, 5) : outcome.retry;
    await finish(outcome.state, { error: outcome.error, ...(outcome.state === 'retry' ? { retry_in_seconds: seconds } : {}) })
      .catch(() => null);
    return outcome.state;
  }

  async function tick() {
    const started = Date.now();
    const processed = [];
    while (Date.now() - started < budgetMs && processed.length < 10) {
      const job = await rest.rpc('instagram_publisher_claim', { p_lease_seconds: 300 });
      if (!job) break;
      processed.push(await publishJob(job));
    }
    return { processed };
  }

  // "Testar sem publicar": monta o post no Instagram e para antes do media_publish.
  async function test(postId) {
    const context = await rest.rpc('instagram_publisher_test_context', { p_post: postId });
    const ig = client(context.token);
    try {
      const container = await createContainer(ig, context);
      const answer = await waitFinished(ig, container, context.kind);
      return await reportTest(context, container, answer);
    } catch (error) {
      const message = friendlyError(error).error.replace(/ e agende( de novo| outra vez)?\./, '.');
      await rest.rpc('instagram_publisher_test_record', { p_post: postId, p_container_id: null, p_result: message }).catch(() => null);
      return [{ state: 'failed', error: message }, 422];
    }
  }

  // Vídeo que ainda estava processando no teste: pergunta de novo ao Instagram.
  async function testStatus(postId) {
    const context = await rest.rpc('instagram_publisher_test_context', { p_post: postId });
    if (!context.test_container_id) return [{ state: 'none', error: 'Este post ainda não foi testado. Rode: npm run testar -- <id>' }, 409];
    const answer = await client(context.token).status(context.test_container_id);
    return reportTest(context, context.test_container_id, answer);
  }

  async function reportTest(context, container, answer) {
    const what = KIND_TEXT[context.kind](context.media.length);
    let result = [{ state: 'processing', message: `O Instagram de @${context.username} está processando ${what}. Nada foi publicado.` }, 200];
    if (answer.status_code === 'FINISHED') {
      result = [{ state: 'ok', message: `O Instagram de @${context.username} aceitou ${what}. Nada foi publicado.` }, 200];
    } else if (answer.status_code !== 'IN_PROGRESS') {
      const detail = answer.status ? ` (${String(answer.status).slice(0, 160)})` : '';
      result = [{ state: 'failed', error: `${containerRefusal(context.kind).replace(/ e agende outra vez\./, '.')}${detail}` }, 422];
    }
    const text = result[0].message || result[0].error;
    await rest.rpc('instagram_publisher_test_record', { p_post: context.post_id, p_container_id: container, p_result: text });
    return result;
  }

  // Confere a conexão perguntando à Meta: @, número de posts e cota de publicações do dia.
  async function check(accountKey) {
    const context = await rest.rpc('instagram_publisher_connection_context', { p_account_key: accountKey || 'principal' });
    const ig = client(context.token);
    const account = await ig.account(context.ig_user_id);
    const limit = await ig.publishingLimit(context.ig_user_id).catch(() => null);
    const quota = limit?.data?.[0];
    return [{ account: context.account, username: account.username || context.username, media_count: account.media_count ?? null,
      quota_used: quota?.quota_usage ?? null, quota_total: quota?.config?.quota_total ?? null, expires_at: context.expires_at }, 200];
  }

  return { tick, test, testStatus, check, publishJob };
}
