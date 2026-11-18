-- Publicador de Instagram: publica foto, carrossel e Reels sozinho, no horário marcado, pela API oficial da Meta.
--
-- Tudo fica no seu próprio projeto do Supabase:
--   * tabelas no esquema privado instagram_publisher, fora da API pública;
--   * a chave do Instagram e a chave secreta do app da Meta no Vault (cofre criptografado do Supabase);
--   * imagens e vídeos no bucket privado instagram-publisher;
--   * um agendador (pg_cron) que, a cada minuto, acorda a função "publicador" só quando há post vencendo.
--
-- As funções public.instagram_publisher_* só aceitam a chave secreta do projeto (service_role).
-- O arquivo pode ser aplicado mais de uma vez: nada é apagado e nada é duplicado.

-- 1. Extensões. No Supabase elas já vêm instaladas ou ficam a um comando de distância.
create extension if not exists pgcrypto with schema extensions;
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'vault') then
    create extension supabase_vault;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    create extension pg_net with schema extensions;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'cron') then
    create extension pg_cron with schema pg_catalog;
  end if;
end;
$$;

-- 2. Tabelas privadas.
create schema if not exists instagram_publisher;
revoke all on schema instagram_publisher from public;

-- Uma linha por Instagram que você quer publicar. A maioria das pessoas usa só "principal".
create table if not exists instagram_publisher.accounts (
  id uuid primary key default gen_random_uuid(),
  account_key text not null unique check (account_key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  expected_username text check (expected_username ~ '^[a-z0-9_.]{1,30}$'),
  created_at timestamptz not null default now()
);

-- A chave de acesso fica no Vault com o nome instagram_publisher_token_<account_id>.
create table if not exists instagram_publisher.connections (
  account_id uuid primary key references instagram_publisher.accounts(id) on delete cascade,
  ig_user_id text not null unique check (ig_user_id ~ '^[0-9]{5,40}$'),
  username text not null check (username ~ '^[A-Za-z0-9_.]{1,30}$'),
  scopes text[] not null,
  expires_at timestamptz, -- vazio: chave da Página, que não vence
  connected_at timestamptz not null default now()
);

-- Pedido de autorização aberto na tela da Meta. Vale 30 minutos (a Meta pode pedir SMS no meio).
create table if not exists instagram_publisher.oauth_requests (
  state text primary key check (state ~ '^[0-9a-f]{64}$'),
  account_id uuid not null references instagram_publisher.accounts(id) on delete cascade,
  expires_at timestamptz not null
);

-- A Meta aprovou, mas o Instagram certo ainda não apareceu: a chave espera no Vault para "retomar" sem novo login.
create table if not exists instagram_publisher.pending_tokens (
  account_id uuid primary key references instagram_publisher.accounts(id) on delete cascade,
  scopes text[] not null,
  created_at timestamptz not null default now()
);

-- Cada post é também o seu item na fila. media guarda os caminhos no bucket, na ordem do carrossel.
create table if not exists instagram_publisher.posts (
  id uuid primary key,
  account_id uuid not null references instagram_publisher.accounts(id) on delete cascade,
  kind text not null check (kind in ('image', 'carousel', 'reel')),
  title text not null check (length(trim(title)) between 1 and 160),
  caption text not null check (length(caption) <= 2200),
  media jsonb not null check (jsonb_typeof(media) = 'array'),
  state text not null default 'draft'
    check (state in ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  scheduled_at timestamptz,
  phase text check (phase ~ '^[a-z_]{1,40}$'),
  attempts integer not null default 0 check (attempts >= 0),
  lease_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz,
  children jsonb,
  container_id text check (container_id ~ '^[0-9]{1,40}$'),
  media_id text check (media_id ~ '^[0-9]{1,40}$'),
  permalink text check (permalink ~ '^https://(www\.)?instagram\.com/'),
  published_at timestamptz,
  media_removed_at timestamptz,
  last_error text check (length(last_error) <= 500),
  test_container_id text check (test_container_id ~ '^[0-9]{1,40}$'),
  test_result text check (length(test_result) <= 500),
  tested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'image' and jsonb_array_length(media) = 1)
    or (kind = 'carousel' and jsonb_array_length(media) between 2 and 10)
    or (kind = 'reel' and jsonb_array_length(media) = 1)
  ),
  check ((state in ('scheduled', 'publishing')) <= (scheduled_at is not null))
);
create index if not exists posts_due_idx on instagram_publisher.posts (scheduled_at)
  where state in ('scheduled', 'publishing');
create index if not exists posts_account_idx on instagram_publisher.posts (account_id);

revoke all on all tables in schema instagram_publisher from public;

-- 3. Bucket privado das mídias. 50 MB é o limite de envio do plano grátis do Supabase.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('instagram-publisher', 'instagram-publisher', false, 52428800, array['image/jpeg', 'video/mp4'])
on conflict (id) do nothing;

-- 4. Cofre (Vault). Os segredos são achados pelo nome.
create or replace function instagram_publisher.put_secret(p_name text, p_value text, p_description text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = p_name;
  if v_id is null then
    v_id := vault.create_secret(p_value, p_name, p_description);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
  return v_id;
end;
$$;

create or replace function instagram_publisher.read_secret(p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = p_name limit 1;
$$;

create or replace function instagram_publisher.drop_secret(p_name text)
returns void language sql security definer set search_path = '' as $$
  delete from vault.secrets s where s.name = p_name;
$$;

-- Segredo que o agendador apresenta à função. Gerado aqui, nunca sai do banco.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'instagram_publisher_cron_secret',
  'Chamada do agendador para a função publicador')
where not exists (select 1 from vault.secrets where name = 'instagram_publisher_cron_secret');

create or replace function instagram_publisher.post_summary(p instagram_publisher.posts)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'account', a.account_key, 'username', c.username, 'kind', p.kind, 'title', p.title,
    'caption_preview', left(p.caption, 80), 'media_count', jsonb_array_length(p.media), 'state', p.state,
    'scheduled_at', p.scheduled_at, 'attempts', p.attempts, 'phase', p.phase, 'permalink', p.permalink,
    'published_at', p.published_at, 'last_error', p.last_error, 'test_result', p.test_result,
    'tested_at', p.tested_at, 'created_at', p.created_at)
  from instagram_publisher.accounts a
  left join instagram_publisher.connections c on c.account_id = a.id
  where a.id = p.account_id;
$$;

create or replace function instagram_publisher.connection_active(p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from instagram_publisher.connections c
    where c.account_id = p_account and (c.expires_at is null or c.expires_at > now())
  );
$$;

-- 5. Configuração: endereço do projeto (para o agendador) e o app da Meta. Chamada pela função publicador.
create or replace function public.instagram_publisher_configure(
  p_project_url text, p_app_id text, p_app_secret text, p_config_id text, p_graph_version text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_project_url, '') !~ '^https://[a-z0-9.-]+$' then
    raise exception 'Endereço do projeto inválido.';
  end if;
  perform instagram_publisher.put_secret('instagram_publisher_project_url', p_project_url,
    'Endereço do projeto, usado pelo agendador');
  if p_app_id is null then
    return jsonb_build_object('meta_configured',
      instagram_publisher.read_secret('instagram_publisher_meta_app_secret') is not null);
  end if;
  if p_app_id !~ '^[0-9]{5,30}$' then raise exception 'O ID do app da Meta tem só números.'; end if;
  if coalesce(p_config_id, '') !~ '^[0-9]{5,30}$' then
    raise exception 'O ID da configuração do login tem só números.';
  end if;
  if coalesce(p_app_secret, '') !~* '^[0-9a-f]{32}$' then
    raise exception 'A chave secreta do app da Meta tem 32 letras e números.';
  end if;
  if coalesce(p_graph_version, '') !~ '^v[0-9]{2}\.[0-9]$' then
    raise exception 'Versão da API da Meta inválida (exemplo: v26.0).';
  end if;
  perform instagram_publisher.put_secret('instagram_publisher_meta_app_id', p_app_id, 'ID do app da Meta');
  perform instagram_publisher.put_secret('instagram_publisher_meta_app_secret', p_app_secret, 'Chave secreta do app da Meta');
  perform instagram_publisher.put_secret('instagram_publisher_meta_config_id', p_config_id, 'ID da configuração do login');
  perform instagram_publisher.put_secret('instagram_publisher_meta_graph_version', p_graph_version, 'Versão da API da Meta');
  return jsonb_build_object('meta_configured', true);
end;
$$;

create or replace function public.instagram_publisher_meta_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'app_id', instagram_publisher.read_secret('instagram_publisher_meta_app_id'),
    'app_secret', instagram_publisher.read_secret('instagram_publisher_meta_app_secret'),
    'config_id', instagram_publisher.read_secret('instagram_publisher_meta_config_id'),
    'graph_version', coalesce(instagram_publisher.read_secret('instagram_publisher_meta_graph_version'), 'v26.0'));
$$;

create or replace function public.instagram_publisher_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'meta_configured', instagram_publisher.read_secret('instagram_publisher_meta_app_secret') is not null,
    'scheduler_ready', instagram_publisher.read_secret('instagram_publisher_project_url') is not null
      and exists (select 1 from cron.job j where j.jobname = 'instagram-publisher' and j.active),
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'account', a.account_key, 'expected_username', a.expected_username, 'username', c.username,
        'connected_at', c.connected_at, 'expires_at', c.expires_at,
        'pending', exists (select 1 from instagram_publisher.pending_tokens t where t.account_id = a.id),
        'pending_at', (select t.created_at from instagram_publisher.pending_tokens t where t.account_id = a.id))
        order by a.created_at)
      from instagram_publisher.accounts a
      left join instagram_publisher.connections c on c.account_id = a.id), '[]'::jsonb),
    'queue', jsonb_build_object(
      'scheduled', (select count(*) from instagram_publisher.posts where state in ('scheduled', 'publishing')),
      'failed', (select count(*) from instagram_publisher.posts where state = 'failed'),
      'next', (select instagram_publisher.post_summary(p) from instagram_publisher.posts p
               where p.state in ('scheduled', 'publishing') order by p.scheduled_at limit 1),
      'last_published', (select instagram_publisher.post_summary(p) from instagram_publisher.posts p
               where p.state = 'published' order by p.published_at desc nulls last limit 1)));
$$;

-- 6. Conexão com a Meta (login do Facebook para Empresas, chave da Página).
create or replace function public.instagram_publisher_oauth_begin(p_account_key text, p_expected_username text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := lower(trim(coalesce(p_account_key, 'principal')));
  v_expected text := nullif(lower(ltrim(trim(coalesce(p_expected_username, '')), '@')), '');
  v_account instagram_publisher.accounts;
  v_state text;
begin
  insert into instagram_publisher.accounts as a (account_key, expected_username) values (v_key, v_expected)
  on conflict (account_key) do update set expected_username = coalesce(excluded.expected_username, a.expected_username)
  returning * into v_account;
  delete from instagram_publisher.oauth_requests r where r.expires_at < now() or r.account_id = v_account.id;
  v_state := encode(extensions.gen_random_bytes(32), 'hex');
  insert into instagram_publisher.oauth_requests (state, account_id, expires_at)
  values (v_state, v_account.id, now() + interval '30 minutes');
  return jsonb_build_object('state', v_state, 'account', v_account.account_key,
    'expected_username', v_account.expected_username);
end;
$$;

create or replace function public.instagram_publisher_oauth_consume(p_state text)
returns jsonb language sql security definer set search_path = '' as $$
  with used as (
    delete from instagram_publisher.oauth_requests r
    where r.state = p_state and r.expires_at > now()
    returning r.account_id
  )
  select jsonb_build_object('account_id', a.id, 'account', a.account_key, 'expected_username', a.expected_username)
  from used join instagram_publisher.accounts a on a.id = used.account_id;
$$;

create or replace function public.instagram_publisher_save_connection(
  p_account uuid, p_ig_user_id text, p_username text, p_token text, p_scopes text[], p_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account instagram_publisher.accounts;
begin
  select * into v_account from instagram_publisher.accounts a where a.id = p_account for update;
  if not found then raise exception 'account_not_found'; end if;
  if v_account.expected_username is not null and v_account.expected_username <> lower(p_username) then
    raise exception 'username_mismatch';
  end if;
  if exists (select 1 from instagram_publisher.connections c where c.ig_user_id = p_ig_user_id and c.account_id <> p_account) then
    raise exception 'instagram_in_use';
  end if;
  if not (coalesce(p_scopes, '{}') && array['instagram_content_publish', 'instagram_business_content_publish']) then
    raise exception 'missing_publish_scope';
  end if;
  if p_token is null or length(p_token) < 20 or (p_expires_at is not null and p_expires_at <= now()) then
    raise exception 'invalid_token';
  end if;
  perform instagram_publisher.put_secret('instagram_publisher_token_' || p_account::text, p_token,
    'Chave do Instagram usada pelo publicador');
  insert into instagram_publisher.connections as c (account_id, ig_user_id, username, scopes, expires_at, connected_at)
  values (p_account, p_ig_user_id, p_username, p_scopes, p_expires_at, now())
  on conflict (account_id) do update set ig_user_id = excluded.ig_user_id, username = excluded.username,
    scopes = excluded.scopes, expires_at = excluded.expires_at, connected_at = now();
  update instagram_publisher.accounts set expected_username = coalesce(expected_username, lower(p_username))
  where id = p_account;
  delete from instagram_publisher.pending_tokens t where t.account_id = p_account;
  perform instagram_publisher.drop_secret('instagram_publisher_pending_' || p_account::text);
  return jsonb_build_object('account', v_account.account_key, 'username', p_username);
end;
$$;

create or replace function public.instagram_publisher_keep_pending(p_account uuid, p_token text, p_scopes text[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_token is null or length(p_token) < 20 then raise exception 'invalid_token'; end if;
  perform instagram_publisher.put_secret('instagram_publisher_pending_' || p_account::text, p_token,
    'Chave da Meta aguardando o Instagram certo');
  insert into instagram_publisher.pending_tokens as t (account_id, scopes) values (p_account, coalesce(p_scopes, '{}'))
  on conflict (account_id) do update set scopes = excluded.scopes, created_at = now();
end;
$$;

-- Pode trocar o @ esperado na mesma chamada, para retomar escolhendo outro Instagram.
create or replace function public.instagram_publisher_take_pending(p_account_key text, p_expected_username text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account instagram_publisher.accounts;
  v_expected text := nullif(lower(ltrim(trim(coalesce(p_expected_username, '')), '@')), '');
  v_pending instagram_publisher.pending_tokens;
begin
  select * into v_account from instagram_publisher.accounts a where a.account_key = lower(trim(coalesce(p_account_key, 'principal')));
  if not found then return null; end if;
  select * into v_pending from instagram_publisher.pending_tokens t where t.account_id = v_account.id;
  if not found then return null; end if;
  if v_expected is not null then
    update instagram_publisher.accounts set expected_username = v_expected where id = v_account.id;
    v_account.expected_username := v_expected;
  end if;
  return jsonb_build_object('account_id', v_account.id, 'account', v_account.account_key,
    'expected_username', v_account.expected_username, 'scopes', v_pending.scopes,
    'token', instagram_publisher.read_secret('instagram_publisher_pending_' || v_account.id::text));
end;
$$;

create or replace function public.instagram_publisher_disconnect(p_account_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account instagram_publisher.accounts;
  v_username text;
begin
  select * into v_account from instagram_publisher.accounts a where a.account_key = lower(trim(coalesce(p_account_key, 'principal')));
  if not found then raise exception 'Conta % não encontrada.', p_account_key; end if;
  delete from instagram_publisher.connections c where c.account_id = v_account.id returning c.username into v_username;
  delete from instagram_publisher.pending_tokens t where t.account_id = v_account.id;
  perform instagram_publisher.drop_secret('instagram_publisher_token_' || v_account.id::text);
  perform instagram_publisher.drop_secret('instagram_publisher_pending_' || v_account.id::text);
  return jsonb_build_object('account', v_account.account_key, 'username', v_username);
end;
$$;

-- Chave e conta para a função conferir a conexão com a Meta.
create or replace function public.instagram_publisher_connection_context(p_account_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account instagram_publisher.accounts;
  v_connection instagram_publisher.connections;
begin
  select * into v_account from instagram_publisher.accounts a where a.account_key = lower(trim(coalesce(p_account_key, 'principal')));
  if not found then raise exception 'not_connected'; end if;
  select * into v_connection from instagram_publisher.connections c
  where c.account_id = v_account.id and (c.expires_at is null or c.expires_at > now());
  if not found then raise exception 'not_connected'; end if;
  return jsonb_build_object('account', v_account.account_key, 'ig_user_id', v_connection.ig_user_id,
    'username', v_connection.username, 'scopes', v_connection.scopes, 'expires_at', v_connection.expires_at,
    'token', instagram_publisher.read_secret('instagram_publisher_token_' || v_account.id::text));
end;
$$;

-- 7. Posts e fila.
create or replace function public.instagram_publisher_create_post(
  p_post uuid, p_account_key text, p_kind text, p_title text, p_caption text, p_media jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account instagram_publisher.accounts;
  v_item jsonb;
  v_index integer := 0;
  v_expected text;
  v_post instagram_publisher.posts;
begin
  select * into v_account from instagram_publisher.accounts a where a.account_key = lower(trim(coalesce(p_account_key, 'principal')));
  if not found then raise exception 'Conecte o Instagram antes de criar posts (npm run conectar).'; end if;
  if p_kind not in ('image', 'carousel', 'reel') then raise exception 'Tipo de post inválido.'; end if;
  if jsonb_typeof(p_media) is distinct from 'array' then raise exception 'Lista de mídias inválida.'; end if;
  if length(coalesce(p_caption, '')) > 2200 then raise exception 'A legenda passa de 2.200 caracteres.'; end if;
  for v_item in select value from jsonb_array_elements(p_media) loop
    v_index := v_index + 1;
    v_expected := p_post::text || '/' || case when p_kind = 'reel' then 'video.mp4'
      else lpad(v_index::text, 2, '0') || '.jpg' end;
    if v_item->>'path' is distinct from v_expected or not exists (
      select 1 from storage.objects o where o.bucket_id = 'instagram-publisher' and o.name = v_expected) then
      raise exception 'A mídia % não foi encontrada no armazenamento. Envie de novo.', v_index;
    end if;
  end loop;
  insert into instagram_publisher.posts (id, account_id, kind, title, caption, media)
  values (p_post, v_account.id, p_kind, trim(coalesce(p_title, '')), trim(coalesce(p_caption, '')),
    (select jsonb_agg(jsonb_build_object('path', value->>'path')) from jsonb_array_elements(p_media)))
  returning * into v_post;
  return instagram_publisher.post_summary(v_post);
end;
$$;

create or replace function public.instagram_publisher_schedule(p_post uuid, p_when timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_post instagram_publisher.posts;
begin
  select * into v_post from instagram_publisher.posts p where p.id = p_post for update;
  if not found then raise exception 'Post não encontrado.'; end if;
  if v_post.state in ('publishing', 'published') or v_post.media_id is not null then
    raise exception 'Este post já está sendo publicado ou já saiu no Instagram.';
  end if;
  if v_post.state = 'scheduled' and v_post.attempts > 0 then
    raise exception 'O publicador já começou a enviar este post. Confira com npm run fila antes de mudar.';
  end if;
  if v_post.media_removed_at is not null then raise exception 'As mídias deste post já foram apagadas. Crie um post novo.'; end if;
  if not instagram_publisher.connection_active(v_post.account_id) then
    raise exception 'Conecte o Instagram antes de agendar (npm run conectar).';
  end if;
  if p_when is null or p_when < now() - interval '1 minute' or p_when > now() + interval '120 days' then
    raise exception 'Escolha um horário entre agora e 120 dias à frente.';
  end if;
  update instagram_publisher.posts set state = 'scheduled', scheduled_at = greatest(p_when, now()), phase = null,
    attempts = 0, lease_id = null, lease_until = null, next_attempt_at = null, children = null, container_id = null,
    permalink = null, published_at = null, last_error = null, updated_at = now()
  where id = p_post returning * into v_post;
  return instagram_publisher.post_summary(v_post);
end;
$$;

create or replace function public.instagram_publisher_cancel(p_post uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_post instagram_publisher.posts;
begin
  select * into v_post from instagram_publisher.posts p where p.id = p_post for update;
  if not found then raise exception 'Post não encontrado.'; end if;
  if v_post.state in ('publishing', 'published') then
    raise exception 'A publicação já começou ou terminou; não dá mais para cancelar.';
  end if;
  update instagram_publisher.posts set state = 'cancelled', lease_id = null, lease_until = null,
    next_attempt_at = null, updated_at = now()
  where id = p_post returning * into v_post;
  return instagram_publisher.post_summary(v_post);
end;
$$;

create or replace function public.instagram_publisher_list(p_limit integer default 20)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(instagram_publisher.post_summary(p) order by coalesce(p.scheduled_at, p.created_at) desc), '[]'::jsonb)
  from instagram_publisher.posts p
  where p.id in (select r.id from instagram_publisher.posts r
                 order by coalesce(r.scheduled_at, r.created_at) desc
                 limit least(greatest(coalesce(p_limit, 20), 1), 100));
$$;

create or replace function public.instagram_publisher_get(p_post uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select instagram_publisher.post_summary(p) from instagram_publisher.posts p where p.id = p_post;
$$;

-- Teste sem publicar: a mesma chave e a mesma legenda que o publicador vai usar.
create or replace function public.instagram_publisher_test_context(p_post uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_post instagram_publisher.posts;
  v_connection instagram_publisher.connections;
begin
  select * into v_post from instagram_publisher.posts p where p.id = p_post;
  if not found then raise exception 'not_found'; end if;
  select * into v_connection from instagram_publisher.connections c
  where c.account_id = v_post.account_id and (c.expires_at is null or c.expires_at > now());
  if not found then raise exception 'not_connected'; end if;
  return jsonb_build_object('post_id', v_post.id, 'kind', v_post.kind, 'media', v_post.media, 'caption', v_post.caption,
    'test_container_id', v_post.test_container_id, 'ig_user_id', v_connection.ig_user_id,
    'username', v_connection.username,
    'token', instagram_publisher.read_secret('instagram_publisher_token_' || v_post.account_id::text));
end;
$$;

create or replace function public.instagram_publisher_test_record(p_post uuid, p_container_id text, p_result text)
returns void language sql security definer set search_path = '' as $$
  update instagram_publisher.posts set test_container_id = p_container_id, test_result = left(p_result, 500),
    tested_at = now(), updated_at = now()
  where id = p_post;
$$;

-- Reserva um post vencido por alguns minutos (lease). Conexão inativa ou tentativas demais viram "falhou".
create or replace function public.instagram_publisher_claim(p_lease_seconds integer default 300)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_post instagram_publisher.posts;
  v_connection instagram_publisher.connections;
  v_lease uuid := gen_random_uuid();
begin
  loop
    select * into v_post from instagram_publisher.posts p
    where (p.state = 'scheduled' and p.scheduled_at <= now() and coalesce(p.next_attempt_at, '-infinity') <= now())
       or (p.state = 'publishing' and p.lease_until < now())
    order by p.scheduled_at
    for update skip locked limit 1;
    if not found then return null; end if;
    select * into v_connection from instagram_publisher.connections c
    where c.account_id = v_post.account_id and (c.expires_at is null or c.expires_at > now());
    if not found then
      update instagram_publisher.posts set state = 'failed', lease_id = null, lease_until = null, updated_at = now(),
        last_error = 'A conexão com o Instagram não está ativa. Conecte de novo (npm run conectar) e agende outra vez.'
      where id = v_post.id;
      continue;
    end if;
    if v_post.attempts >= 8 then
      update instagram_publisher.posts set state = 'failed', lease_id = null, lease_until = null, updated_at = now(),
        last_error = 'O Instagram não confirmou a publicação depois de várias tentativas. Confira o perfil antes de agendar de novo.'
      where id = v_post.id;
      continue;
    end if;
    update instagram_publisher.posts set state = 'publishing', lease_id = v_lease,
      lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 60)), attempts = attempts + 1,
      next_attempt_at = null, updated_at = now()
    where id = v_post.id;
    return jsonb_build_object('post_id', v_post.id, 'lease_id', v_lease, 'account_id', v_post.account_id,
      'kind', v_post.kind, 'attempt', v_post.attempts + 1, 'media', v_post.media, 'children', v_post.children,
      'container_id', v_post.container_id, 'media_id', v_post.media_id, 'caption', v_post.caption,
      'scheduled_at', v_post.scheduled_at, 'ig_user_id', v_connection.ig_user_id, 'username', v_connection.username,
      'token', instagram_publisher.read_secret('instagram_publisher_token_' || v_post.account_id::text));
  end loop;
end;
$$;

-- Grava o andamento. As chaves presentes em p_patch são escritas (null em JSON limpa o campo).
-- Devolve false se a reserva expirou ou o post mudou de mãos.
create or replace function public.instagram_publisher_checkpoint(p_post uuid, p_lease uuid, p_patch jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update instagram_publisher.posts p set
    phase = coalesce(p_patch->>'phase', p.phase),
    children = case when p_patch ? 'children' then nullif(p_patch->'children', 'null'::jsonb) else p.children end,
    container_id = case when p_patch ? 'container_id' then p_patch->>'container_id' else p.container_id end,
    media_id = case when p_patch ? 'media_id' then p_patch->>'media_id' else p.media_id end,
    lease_until = greatest(p.lease_until, now() + interval '2 minutes'), updated_at = now()
  where p.id = p_post and p.lease_id = p_lease and p.state = 'publishing';
  return found;
end;
$$;

-- p_state: published | failed | retry (volta para a fila depois de retry_in_seconds, mantendo o container).
create or replace function public.instagram_publisher_finish(p_post uuid, p_lease uuid, p_state text, p_patch jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_state not in ('published', 'failed', 'retry') then raise exception 'Estado inválido.'; end if;
  update instagram_publisher.posts p set
    state = case p_state when 'retry' then 'scheduled' else p_state end,
    next_attempt_at = case when p_state = 'retry' then now() + make_interval(secs =>
      least(greatest(coalesce((p_patch->>'retry_in_seconds')::integer, 60), 30), 3600)) end,
    phase = coalesce(p_patch->>'phase', p.phase),
    children = case when p_patch ? 'children' then nullif(p_patch->'children', 'null'::jsonb) else p.children end,
    container_id = case when p_patch ? 'container_id' then p_patch->>'container_id' else p.container_id end,
    media_id = case when p_patch ? 'media_id' then p_patch->>'media_id' else p.media_id end,
    permalink = case when p_state = 'published' then p_patch->>'permalink' else p.permalink end,
    published_at = case when p_state = 'published'
      then coalesce((p_patch->>'published_at')::timestamptz, now()) else p.published_at end,
    last_error = case when p_state = 'published' then null else left(p_patch->>'error', 500) end,
    lease_id = null, lease_until = null, updated_at = now()
  where p.id = p_post and p.lease_id = p_lease and p.state = 'publishing';
  return found;
end;
$$;

-- Depois que o post sai, a função apaga as mídias do bucket (o plano grátis tem 1 GB) e registra aqui.
create or replace function public.instagram_publisher_media_removed(p_post uuid)
returns void language sql security definer set search_path = '' as $$
  update instagram_publisher.posts set media_removed_at = now(), updated_at = now()
  where id = p_post and state = 'published';
$$;

create or replace function public.instagram_publisher_media_to_remove(p_limit integer default 50)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('post_id', p.id, 'media', p.media)), '[]'::jsonb)
  from (select id, media from instagram_publisher.posts
        where state = 'published' and media_removed_at is null
        order by published_at limit least(greatest(coalesce(p_limit, 50), 1), 200)) p;
$$;

-- 8. Agendador: a cada minuto, só acorda a função se houver post vencendo.
create or replace function public.instagram_publisher_cron_ok(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(length(p_secret) >= 64
    and p_secret = instagram_publisher.read_secret('instagram_publisher_cron_secret'), false);
$$;

create or replace function instagram_publisher.tick()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url text := instagram_publisher.read_secret('instagram_publisher_project_url');
begin
  if v_url is null then return; end if;
  if not exists (
    select 1 from instagram_publisher.posts p
    where (p.state = 'scheduled' and p.scheduled_at <= now() and coalesce(p.next_attempt_at, '-infinity') <= now())
       or (p.state = 'publishing' and p.lease_until < now())) then
    return;
  end if;
  perform net.http_post(
    url := v_url || '/functions/v1/publicador',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-publicador-cron', instagram_publisher.read_secret('instagram_publisher_cron_secret')),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 150000);
end;
$$;

select cron.schedule('instagram-publisher', '* * * * *', 'select instagram_publisher.tick()');

-- 9. Só a chave secreta do projeto chama estas funções. Nada fica aberto para visitantes ou usuários logados.
do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'instagram_publisher'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_function);
  end loop;
  for v_function in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'instagram\_publisher\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
