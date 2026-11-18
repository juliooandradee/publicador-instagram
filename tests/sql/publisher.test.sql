-- Testes da migração. Rodam dentro de uma transação desfeita no final.
begin;

create function pg_temp.expect_error(p_sql text, p_fragment text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_fragment in sqlerrm) = 0 then
      raise exception 'Erro inesperado: % (esperava "%")', sqlerrm, p_fragment;
    end if;
    return;
  end;
  raise exception 'Esperava um erro com "%" em: %', p_fragment, p_sql;
end;
$$;

-- 1. Ninguém além da chave secreta do projeto chama as funções; o esquema privado fica fechado.
do $$
begin
  assert not has_function_privilege('anon', 'public.instagram_publisher_claim(integer)', 'execute'), 'anon chama claim';
  assert not has_function_privilege('authenticated', 'public.instagram_publisher_status()', 'execute'), 'authenticated chama status';
  assert not has_function_privilege('anon', 'public.instagram_publisher_meta_config()', 'execute'), 'anon lê o app da Meta';
  assert has_function_privilege('service_role', 'public.instagram_publisher_claim(integer)', 'execute'), 'service_role sem claim';
  assert not has_function_privilege('service_role', 'instagram_publisher.read_secret(text)', 'execute'), 'read_secret exposto';
  assert not has_schema_privilege('anon', 'instagram_publisher', 'usage'), 'esquema privado aberto';
  assert (select count(*) from cron.job where jobname = 'instagram-publisher') = 1, 'agendador duplicado ou ausente';
  assert (select count(*) from vault.secrets where name = 'instagram_publisher_cron_secret') = 1, 'segredo do agendador';
  assert (select public = false from storage.buckets where id = 'instagram-publisher'), 'bucket público';
end;
$$;

-- Só para as conferências deste teste: o papel do servidor lê as tabelas privadas e o cofre de mentira.
grant usage on schema instagram_publisher, vault, net, cron to service_role;
grant select on all tables in schema instagram_publisher to service_role;
grant select on vault.secrets, vault.decrypted_secrets, net.requests, cron.job to service_role;
set local role service_role;

-- 2. Configuração.
select pg_temp.expect_error($q$select public.instagram_publisher_configure('http://x.supabase.co', null, null, null, null)$q$, 'Endereço');
select pg_temp.expect_error($q$select public.instagram_publisher_configure('https://x.supabase.co', '12a', 'f' || repeat('0', 31), '123456', 'v26.0')$q$, 'só números');
select pg_temp.expect_error($q$select public.instagram_publisher_configure('https://x.supabase.co', '123456', 'curta', '123456', 'v26.0')$q$, '32 letras');
do $$
begin
  assert (public.instagram_publisher_configure('https://abc.supabase.co', null, null, null, null)->>'meta_configured')::boolean = false;
  assert (public.instagram_publisher_status()->>'meta_configured')::boolean = false, 'Meta ainda não configurada';
  assert (public.instagram_publisher_status()->>'scheduler_ready')::boolean, 'agendador pronto';
  perform public.instagram_publisher_configure('https://abc.supabase.co', '1234567890', repeat('ab', 16), '9876543210', 'v26.0');
  assert public.instagram_publisher_meta_config()->>'app_secret' = repeat('ab', 16);
  assert public.instagram_publisher_meta_config()->>'config_id' = '9876543210';
  assert (public.instagram_publisher_status()->>'meta_configured')::boolean;
end;
$$;

-- 3. Conexão.
do $$
declare
  v_begin jsonb := public.instagram_publisher_oauth_begin('principal', '@Consultorio.Exemplo');
  v_used jsonb;
begin
  assert v_begin->>'state' ~ '^[0-9a-f]{64}$';
  assert v_begin->>'expected_username' = 'consultorio.exemplo';
  v_used := public.instagram_publisher_oauth_consume(v_begin->>'state');
  assert v_used->>'account' = 'principal';
  assert public.instagram_publisher_oauth_consume(v_begin->>'state') is null, 'pedido usado duas vezes';
end;
$$;
do $$
declare
  v_account uuid := (select id from instagram_publisher.accounts where account_key = 'principal');
begin
  perform pg_temp.expect_error(format($q$select public.instagram_publisher_save_connection(%L, '17841400000000001', 'outra.conta', repeat('t', 40), array['instagram_content_publish'], null)$q$, v_account), 'username_mismatch');
  perform pg_temp.expect_error(format($q$select public.instagram_publisher_save_connection(%L, '17841400000000001', 'consultorio.exemplo', repeat('t', 40), array['instagram_basic'], null)$q$, v_account), 'missing_publish_scope');
  perform public.instagram_publisher_keep_pending(v_account, repeat('p', 40), array['instagram_basic']);
  assert (public.instagram_publisher_take_pending('principal', null)->>'token') = repeat('p', 40);
  perform public.instagram_publisher_save_connection(v_account, '17841400000000001', 'consultorio.exemplo', repeat('t', 40),
    array['instagram_basic', 'instagram_content_publish'], null);
  assert public.instagram_publisher_take_pending('principal', null) is null, 'pendência não foi limpa';
  assert (select count(*) from vault.secrets where name like 'instagram_publisher_pending_%') = 0;
  assert public.instagram_publisher_connection_context('principal')->>'token' = repeat('t', 40);
  -- O mesmo Instagram não pode estar em duas contas.
  perform public.instagram_publisher_oauth_begin('clinica', null);
  perform pg_temp.expect_error(format($q$select public.instagram_publisher_save_connection(%L, '17841400000000001', 'consultorio.exemplo', repeat('t', 40), array['instagram_content_publish'], null)$q$,
    (select id from instagram_publisher.accounts where account_key = 'clinica')), 'instagram_in_use');
end;
$$;

-- 4. Posts.
reset role;
insert into storage.objects (bucket_id, name) values
  ('instagram-publisher', '11111111-1111-4111-8111-111111111111/01.jpg'),
  ('instagram-publisher', '11111111-1111-4111-8111-111111111111/02.jpg'),
  ('instagram-publisher', '22222222-2222-4222-8222-222222222222/01.jpg'),
  ('instagram-publisher', '33333333-3333-4333-8333-333333333333/video.mp4'),
  ('instagram-publisher', '44444444-4444-4444-8444-444444444444/01.jpg');
set local role service_role;

select pg_temp.expect_error($q$select public.instagram_publisher_create_post('11111111-1111-4111-8111-111111111111', 'principal', 'carousel', 'Teste', 'Legenda', '[{"path":"11111111-1111-4111-8111-111111111111/01.jpg"},{"path":"11111111-1111-4111-8111-111111111111/03.jpg"}]')$q$, 'mídia 2');
select pg_temp.expect_error($q$select public.instagram_publisher_create_post('22222222-2222-4222-8222-222222222222', 'principal', 'carousel', 'Teste', 'Legenda', '[{"path":"22222222-2222-4222-8222-222222222222/01.jpg"}]')$q$, 'check');
select pg_temp.expect_error($q$select public.instagram_publisher_create_post('22222222-2222-4222-8222-222222222222', 'nao-existe', 'image', 'Teste', 'Legenda', '[{"path":"22222222-2222-4222-8222-222222222222/01.jpg"}]')$q$, 'Conecte');
do $$
declare
  v_carousel jsonb := public.instagram_publisher_create_post('11111111-1111-4111-8111-111111111111', 'principal', 'carousel',
    'Carrossel de teste', 'Legenda do carrossel',
    '[{"path":"11111111-1111-4111-8111-111111111111/01.jpg"},{"path":"11111111-1111-4111-8111-111111111111/02.jpg"}]');
begin
  assert v_carousel->>'state' = 'draft' and (v_carousel->>'media_count')::integer = 2;
  assert v_carousel->>'username' = 'consultorio.exemplo';
  perform public.instagram_publisher_create_post('22222222-2222-4222-8222-222222222222', 'principal', 'image', 'Foto', 'Legenda da foto',
    '[{"path":"22222222-2222-4222-8222-222222222222/01.jpg"}]');
  perform public.instagram_publisher_create_post('33333333-3333-4333-8333-333333333333', 'principal', 'reel', 'Reels', 'Legenda do Reels',
    '[{"path":"33333333-3333-4333-8333-333333333333/video.mp4"}]');
  perform public.instagram_publisher_create_post('44444444-4444-4444-8444-444444444444', 'clinica', 'image', 'Sem conexão', 'Legenda',
    '[{"path":"44444444-4444-4444-8444-444444444444/01.jpg"}]');
  assert jsonb_array_length(public.instagram_publisher_list(10)) = 4;
end;
$$;

select pg_temp.expect_error($q$select public.instagram_publisher_schedule('44444444-4444-4444-8444-444444444444', now() + interval '1 hour')$q$, 'Conecte');
select pg_temp.expect_error($q$select public.instagram_publisher_schedule('11111111-1111-4111-8111-111111111111', now() - interval '1 hour')$q$, 'entre agora');
select pg_temp.expect_error($q$select public.instagram_publisher_schedule('11111111-1111-4111-8111-111111111111', now() + interval '200 days')$q$, 'entre agora');

-- 5. Fila: reserva, andamento, nova tentativa e publicação.
do $$
declare
  v_job jsonb;
  v_lease uuid;
begin
  assert public.instagram_publisher_claim(300) is null, 'nada vencido ainda';
  perform public.instagram_publisher_schedule('11111111-1111-4111-8111-111111111111', now());
  perform public.instagram_publisher_schedule('22222222-2222-4222-8222-222222222222', now() + interval '1 day');
  -- O agendador só chama a função quando há post vencendo.
  reset role;
  perform instagram_publisher.tick();
  set local role service_role;
  assert (select count(*) from net.requests) = 1, 'tick deveria chamar a função';
  assert (select url from net.requests) = 'https://abc.supabase.co/functions/v1/publicador';
  assert (select headers->>'x-publicador-cron' from net.requests) = (select decrypted_secret from vault.decrypted_secrets where name = 'instagram_publisher_cron_secret');

  v_job := public.instagram_publisher_claim(300);
  assert v_job->>'post_id' = '11111111-1111-4111-8111-111111111111' and v_job->>'kind' = 'carousel';
  assert v_job->>'token' = repeat('t', 40) and v_job->>'ig_user_id' = '17841400000000001';
  assert (v_job->>'attempt')::integer = 1;
  v_lease := (v_job->>'lease_id')::uuid;
  assert public.instagram_publisher_claim(300) is null, 'post reservado foi entregue duas vezes';
  assert not public.instagram_publisher_checkpoint('11111111-1111-4111-8111-111111111111', gen_random_uuid(), '{"phase":"x"}'), 'reserva errada aceita';
  assert public.instagram_publisher_checkpoint('11111111-1111-4111-8111-111111111111', v_lease, '{"phase":"children_created","children":["10","20"]}');
  assert public.instagram_publisher_checkpoint('11111111-1111-4111-8111-111111111111', v_lease, '{"phase":"container_created","container_id":"333"}');
  perform pg_temp.expect_error($q$select public.instagram_publisher_cancel('11111111-1111-4111-8111-111111111111')$q$, 'não dá mais');
  assert public.instagram_publisher_finish('11111111-1111-4111-8111-111111111111', v_lease, 'retry', '{"phase":"container_processing","retry_in_seconds":60}');
  assert (select state = 'scheduled' and container_id = '333' and next_attempt_at > now() from instagram_publisher.posts
          where id = '11111111-1111-4111-8111-111111111111'), 'nova tentativa sem manter o container';
  assert public.instagram_publisher_claim(300) is null, 'nova tentativa antes da hora';
  perform pg_temp.expect_error($q$select public.instagram_publisher_schedule('11111111-1111-4111-8111-111111111111', now())$q$, 'já começou');
end;
$$;
reset role;
update instagram_publisher.posts set next_attempt_at = now() - interval '1 second' where id = '11111111-1111-4111-8111-111111111111';
set local role service_role;
do $$
declare
  v_job jsonb := public.instagram_publisher_claim(300);
  v_lease uuid := (v_job->>'lease_id')::uuid;
begin
  assert (v_job->>'attempt')::integer = 2 and v_job->>'container_id' = '333';
  assert public.instagram_publisher_finish('11111111-1111-4111-8111-111111111111', v_lease, 'published',
    '{"phase":"published","media_id":"900","permalink":"https://www.instagram.com/p/abc/","published_at":"2026-11-18T12:00:00Z"}');
  assert (select state = 'published' and permalink = 'https://www.instagram.com/p/abc/' and last_error is null
          from instagram_publisher.posts where id = '11111111-1111-4111-8111-111111111111');
  assert not public.instagram_publisher_finish('11111111-1111-4111-8111-111111111111', v_lease, 'failed', '{}'), 'finish depois de publicado';
  perform pg_temp.expect_error($q$select public.instagram_publisher_schedule('11111111-1111-4111-8111-111111111111', now())$q$, 'já saiu');
  assert jsonb_array_length(public.instagram_publisher_media_to_remove(10)) = 1;
  perform public.instagram_publisher_media_removed('11111111-1111-4111-8111-111111111111');
  assert jsonb_array_length(public.instagram_publisher_media_to_remove(10)) = 0;
  assert public.instagram_publisher_status()->'queue'->'last_published'->>'id' = '11111111-1111-4111-8111-111111111111';
  assert (public.instagram_publisher_status()->'queue'->>'scheduled')::integer = 1;
end;
$$;

-- 6. Conexão desfeita: o próximo post vencido vira "falhou" com o motivo, sem chamar o Instagram.
do $$
begin
  perform public.instagram_publisher_schedule('33333333-3333-4333-8333-333333333333', now());
  assert public.instagram_publisher_test_context('33333333-3333-4333-8333-333333333333')->>'kind' = 'reel';
  perform public.instagram_publisher_test_record('33333333-3333-4333-8333-333333333333', '555', 'aceitou');
  assert public.instagram_publisher_get('33333333-3333-4333-8333-333333333333')->>'test_result' = 'aceitou';
  assert public.instagram_publisher_disconnect('principal')->>'username' = 'consultorio.exemplo';
  assert (select count(*) from vault.secrets where name like 'instagram_publisher_token_%') = 0, 'chave ficou no cofre';
  assert public.instagram_publisher_claim(300) is null;
  assert (select state = 'failed' and last_error like 'A conexão com o Instagram não está ativa%'
          from instagram_publisher.posts where id = '33333333-3333-4333-8333-333333333333');
  perform pg_temp.expect_error($q$select public.instagram_publisher_test_context('33333333-3333-4333-8333-333333333333')$q$, 'not_connected');
  assert public.instagram_publisher_cancel('22222222-2222-4222-8222-222222222222')->>'state' = 'cancelled';
  assert public.instagram_publisher_cron_ok((select decrypted_secret from vault.decrypted_secrets where name = 'instagram_publisher_cron_secret'));
  assert not public.instagram_publisher_cron_ok('errado');
  assert not public.instagram_publisher_cron_ok(null);
end;
$$;

rollback;
