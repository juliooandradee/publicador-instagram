// Conversa da linha de comando com o seu projeto do Supabase: banco (RPC), armazenamento e a função publicador.
import fs from 'node:fs';
import { BUCKET, keyHeaders } from '../supabase/functions/_shared/rest.mjs';

const TOO_BIG = /maximum allowed size|exceeded|Payload too large/i;

async function answer(response, fallback) {
  const data = await response.json().catch(() => null);
  if (response.ok) return data;
  const message = data?.message || data?.error || data?.msg || `${fallback} (código ${response.status})`;
  throw new Error(message);
}

export function createApi({ url, key, fetcher = fetch }) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/.test(base)) throw new Error('SUPABASE_URL inválido no .env (exemplo: https://abcdefgh.supabase.co).');
  if (!key || key.length < 20) throw new Error('Falta a SUPABASE_SECRET_KEY no .env (Supabase → Settings → API Keys → secret).');
  // A chave antiga (service_role, que começa com eyJ) para de funcionar no fim de 2026 e a função não a reconhece.
  if (!key.startsWith('sb_secret_')) {
    throw new Error('Use a chave secreta nova, que começa com sb_secret_ (Supabase → Settings → API Keys → Secret keys). '
      + 'A chave service_role antiga não serve para o publicador.');
  }
  const headers = keyHeaders(key);
  const objectUrl = path => `${base}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return {
    async rpc(name, args = {}) {
      const response = await fetcher(`${base}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
      });
      return answer(response, 'O Supabase recusou a operação');
    },
    async upload(objectPath, file, contentType) {
      const body = await fs.openAsBlob(file, { type: contentType });
      const response = await fetcher(objectUrl(objectPath), {
        method: 'POST', headers: { ...headers, 'Content-Type': contentType, 'x-upsert': 'false' }, body,
      });
      try {
        return await answer(response, 'Não foi possível enviar o arquivo');
      } catch (error) {
        if (TOO_BIG.test(error.message)) throw new Error('O arquivo passa do limite de envio do Supabase (50 MB no plano grátis). Para vídeo, use --comprimir.');
        throw error;
      }
    },
    async remove(paths) {
      const response = await fetcher(`${base}/storage/v1/object/${BUCKET}`, {
        method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: paths }),
      });
      return answer(response, 'Não foi possível apagar os arquivos');
    },
    // A função responde com { error } quando algo não deu certo; o status HTTP vai junto.
    async call(action, body = {}) {
      const response = await fetcher(`${base}/functions/v1/publicador`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }),
      });
      const data = await response.json().catch(() => null);
      if (response.status === 404 && !data?.error) throw new Error('A função publicador não está no ar. Publique com: npx supabase functions deploy publicador --no-verify-jwt --use-api');
      return { status: response.status, data: data || {} };
    },
  };
}

export function functionAnswer({ status, data }, fallback = 'A função publicador recusou o pedido.') {
  if (status >= 400 || data?.error) throw new Error(data?.error || `${fallback} (código ${status})`);
  return data;
}
