-- O mínimo do Supabase para testar a migração num Postgres local: papéis, armazenamento, Vault, pg_net e pg_cron.
-- Não é migração e nunca roda no seu projeto.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- Igual ao Supabase: funções novas em public nascem liberadas para anon e authenticated.
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  unique (bucket_id, name)
);

create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text not null);
create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language sql as $$
  insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null)
returns void language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;

create schema net;
create table net.requests (id bigserial primary key, url text, headers jsonb, body jsonb);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{}', timeout_milliseconds integer default 5000)
returns bigint language sql as $$ insert into net.requests (url, headers, body) values (url, headers, body) returning id $$;

create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid
$$;
