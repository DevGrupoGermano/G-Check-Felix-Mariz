-- ============================================================================
-- G-check — dias de folga por rotina (checklist individual)
-- ----------------------------------------------------------------------------
-- O mecanismo de "dias sem expediente" (dias_desativados) pausa TODAS as
-- rotinas de uma vez — pensado pra feriado/loja fechada. Esta migration
-- acrescenta a mesma ideia, mas por rotina: um dia de folga do responsável
-- daquela checklist específica não deveria afetar as outras.
--
--   checklists.dias_pausados  date[]  -> datas em que ESSA rotina não roda
--
-- Nessas datas a rotina se comporta como se não tivesse nenhuma atividade
-- programada (mesmo efeito de nenhum item bater a recorrência naquele dia):
-- some do dashboard, do calendário e da tela de checklists; o rollover não
-- gera snapshot dela no histórico; notificação por e-mail não dispara; a
-- reabertura automática não roda. Cadastrado direto no formulário da rotina
-- (calendário multi-seleção) — sem tabela própria, sem policy nova.
-- ============================================================================

alter table checklists add column if not exists dias_pausados date[] not null default '{}';

-- ---------------------------------------------------------------------------
-- Bloqueio "atividade fora do dia": agora também barra quando a ROTINA (não só
-- a atividade) está de folga hoje.
-- ---------------------------------------------------------------------------
create or replace function public.checklist_items_block_on_disabled_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rotina_pausada_hoje boolean;
begin
  if coalesce(current_setting('app.bypass_item_guard', true), '') = 'on' then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if exists (select 1 from public.dias_desativados where data = current_date) then
    raise exception 'As rotinas de hoje estão desativadas. Fale com o administrador.';
  end if;

  select current_date = any(dias_pausados) into rotina_pausada_hoje
    from public.checklists where id = new.checklist_id;
  if coalesce(rotina_pausada_hoje, false) then
    raise exception 'Esta rotina está de folga hoje.';
  end if;

  if not public.item_roda_no_dia(new.recorrencia, new.dias_semana, new.inicio, current_date) then
    raise exception 'Esta atividade não está programada para hoje.';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Snapshot do dia fechado: rotina de folga naquele dia não gera linha de
-- histórico, igual a um dia globalmente desativado.
-- ---------------------------------------------------------------------------
create or replace function public.rollover_snapshot_dia(alvo date, usar_estado boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into checklist_execucoes
    (checklist_id, data, nome, turno, horario, total_itens, itens_concluidos, completa, itens)
  select
    c.id,
    alvo,
    c.nome,
    null,
    null,
    count(ci.id),
    case when usar_estado
      then count(ci.id) filter (where ci.status = 'concluido')
      else 0 end,
    case when usar_estado
      then (count(ci.id) > 0 and count(ci.id) = count(ci.id) filter (where ci.status = 'concluido'))
      else false end,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'titulo', ci.titulo,
          'responsavel', c.responsavel,
          'status', case when usar_estado then ci.status else 'pendente' end,
          'tipo_tarefa', ci.tipo_tarefa,
          'resposta_opcoes', ci.resposta_opcoes,
          'resposta', case when usar_estado then ci.resposta else null end,
          'justificativa', case when usar_estado then ci.justificativa else null end,
          'turno', ci.turno,
          'horario_inicio', to_char(ci.horario_inicio, 'HH24:MI'),
          'horario_termino', to_char(ci.horario_termino, 'HH24:MI'),
          'min_anexos', ci.min_anexos,
          'max_anexos', ci.max_anexos,
          'anexos', case when usar_estado then ci.anexos else '[]'::jsonb end
        ) order by ci.posicao
      ),
      '[]'
    )
  from checklists c
  join checklist_items ci on ci.checklist_id = c.id
    and public.item_roda_no_dia(ci.recorrencia, ci.dias_semana, ci.inicio, alvo)
  where c.ativo
    and not exists (select 1 from dias_desativados dd where dd.data = alvo)
    and not (alvo = any(c.dias_pausados))
  group by c.id
  on conflict (checklist_id, data) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- Notificação por e-mail: rotina de folga hoje não entra na checagem
-- (nem "concluída", nem "atrasada").
-- ---------------------------------------------------------------------------
create or replace function public.notificar_rotinas()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tz constant text := 'America/Sao_Paulo';
  hoje date := (now() at time zone tz)::date;
  agora time := (now() at time zone tz)::time;
  data_fmt text := to_char(hoje, 'DD/MM/YYYY');
  hora_fmt text := to_char(agora, 'HH24:MI');
  api_key text;
  from_email text;
  app_url text;
  suporte_email text;
  logo_felix text;
  logo_gtech text;
  destinatarios text[];
  c record;
  assunto text;
  html text;
  contagem text;
begin
  perform pg_advisory_xact_lock(hashtext('notificar_rotinas'));

  if exists (select 1 from dias_desativados where data = hoje) then
    return;
  end if;

  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key';
  select decrypted_secret into from_email from vault.decrypted_secrets where name = 'resend_from_email';
  select decrypted_secret into app_url from vault.decrypted_secrets where name = 'app_url';
  select decrypted_secret into suporte_email from vault.decrypted_secrets where name = 'suporte_email';

  -- Ainda não configurado (placeholder da migration) — não tenta enviar.
  if api_key is null or api_key = '' or api_key = 'SUBSTITUA_PELA_SUA_API_KEY' then
    return;
  end if;

  app_url := coalesce(app_url, 'https://felix-matriz.g-check.workers.dev/');
  suporte_email := coalesce(suporte_email, 'g-check@germanoconsultoria.com.br');
  logo_felix := app_url || 'logo-felix.png';
  logo_gtech := app_url || 'logo-gtech.png';

  select array_agg(email) into destinatarios
    from profiles
   where role = 'admin' and email is not null and btrim(email) <> '';
  if destinatarios is null or array_length(destinatarios, 1) = 0 then
    return;
  end if;

  for c in
    select
      ch.id,
      ch.nome,
      ch.responsavel,
      coalesce(ch.tempo_limite, max(ci.horario_termino)) as limite,
      count(*) filter (
        where public.item_roda_no_dia(ci.recorrencia, ci.dias_semana, ci.inicio, hoje)
      ) as total,
      count(*) filter (
        where public.item_roda_no_dia(ci.recorrencia, ci.dias_semana, ci.inicio, hoje)
          and ci.status = 'concluido'
      ) as feitos,
      array_agg(ci.titulo order by ci.posicao) filter (
        where public.item_roda_no_dia(ci.recorrencia, ci.dias_semana, ci.inicio, hoje)
          and ci.status <> 'concluido'
      ) as pendentes
    from checklists ch
    join checklist_items ci on ci.checklist_id = ch.id
    where ch.ativo
      and not (hoje = any(ch.dias_pausados))
    group by ch.id, ch.nome, ch.responsavel, ch.tempo_limite
    having count(*) filter (
      where public.item_roda_no_dia(ci.recorrencia, ci.dias_semana, ci.inicio, hoje)
    ) > 0
  loop
    if c.feitos = c.total then
      if not exists (
        select 1 from checklist_notificacoes
         where checklist_id = c.id and data = hoje and tipo = 'concluida'
      ) then
        assunto := '✅ Rotina concluída: ' || c.nome;
        contagem := format('%s de %s atividades concluídas', c.feitos, c.total);
        html := public.notificar_email_html(
          'CONCLUÍDA', c.nome, c.responsavel, data_fmt, hora_fmt,
          'Todas as atividades programadas para hoje foram concluídas com sucesso.',
          contagem, null,
          app_url, suporte_email, logo_felix, logo_gtech
        );
        if public.resend_enviar(api_key, from_email, destinatarios, assunto, html) then
          insert into checklist_notificacoes (checklist_id, data, tipo)
          values (c.id, hoje, 'concluida');
        end if;
      end if;

    elsif c.limite is not null and agora > c.limite then
      if not exists (
        select 1 from checklist_notificacoes
         where checklist_id = c.id and data = hoje and tipo = 'atrasada'
      ) then
        assunto := '⚠️ Rotina atrasada: ' || c.nome;
        contagem := format('%s de %s atividades atrasadas', c.total - c.feitos, c.total);
        html := public.notificar_email_html(
          'ATRASADA', c.nome, c.responsavel, data_fmt, hora_fmt,
          format('Passou do horário limite (%s) e ainda não foi finalizada.', to_char(c.limite, 'HH24:MI')),
          contagem, c.pendentes,
          app_url, suporte_email, logo_felix, logo_gtech
        );
        if public.resend_enviar(api_key, from_email, destinatarios, assunto, html) then
          insert into checklist_notificacoes (checklist_id, data, tipo)
          values (c.id, hoje, 'atrasada');
        end if;
      end if;
    end if;
  end loop;
end;
$$;

grant execute on function public.notificar_rotinas() to authenticated;

-- ---------------------------------------------------------------------------
-- Reabertura automática: pula rotina de folga hoje.
-- ---------------------------------------------------------------------------
create or replace function public.reabrir_automaticas()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tz constant text := 'America/Sao_Paulo';
  hoje date := (now() at time zone tz)::date;
  c record;
begin
  perform pg_advisory_xact_lock(hashtext('reabrir_automaticas'));

  -- Feriado / dia sem expediente: não reabre nada.
  if exists (select 1 from dias_desativados where data = hoje) then
    return;
  end if;

  perform set_config('app.bypass_item_guard', 'on', true);

  for c in
    select id, reabre_intervalo_min, reaberta_em
      from checklists
     where ativo
       and reabre_automatico
       and reabre_intervalo_min is not null
       and not (hoje = any(dias_pausados))
  loop
    if c.reaberta_em is not null
       and now() - c.reaberta_em < make_interval(mins => c.reabre_intervalo_min)
    then
      continue;
    end if;

    update checklist_items ci
       set status = 'pendente', anexos = '[]'::jsonb, resposta = null, justificativa = null
     where ci.checklist_id = c.id
       and public.item_roda_no_dia(ci.recorrencia, ci.dias_semana, ci.inicio, hoje)
       and (ci.status <> 'pendente'
            or ci.anexos <> '[]'::jsonb
            or ci.resposta is not null
            or ci.justificativa is not null);

    update checklists set reaberta_em = now() where id = c.id;
  end loop;
end;
$$;

grant execute on function public.reabrir_automaticas() to authenticated;
