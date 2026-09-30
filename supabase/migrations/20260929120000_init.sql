-- ============================================================================
-- G-Check-Felix-Matriz — migration inicial (baseline única)
-- ----------------------------------------------------------------------------
-- Consolida em um único arquivo todo o histórico de migrations anteriores
-- (init original + 17 migrations incrementais). Cria TODO o schema já no seu
-- estado final — tabelas, funções, triggers, RLS, storage bucket, cron jobs —
-- e o único login inicial admin@felixmatriz.com. O banco começa sem dados de
-- demonstração (nenhuma checklist, item, setor ou execução).
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Helper genérico de updated_at
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- Tabelas principais
-- ============================================================================

create table if not exists checklists (
  id text primary key,
  nome text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ativo boolean not null default true,
  tempo_limite time,
  reabre_automatico boolean not null default false,
  reabre_intervalo_min integer,
  reaberta_em timestamptz,
  responsavel text not null default '',
  dias_pausados date[] not null default '{}',
  corte_dia time,
  ultimo_rollover_dia date,
  constraint checklists_reabre_intervalo_valido check (
    not reabre_automatico
    or (reabre_intervalo_min is not null and reabre_intervalo_min between 1 and 1440)
  )
);

comment on column checklists.corte_dia is
  'Hora (madrugada) em que o "dia" desta rotina vira. Null = comportamento padrão (vira à meia-noite). Definido (ex.: 06:00) = turno que atravessa a meia-noite (ex.: 23:00-06:00): antes desse horário os itens ainda contam como do dia em que o turno começou, sem resetar nem travar.';
comment on column checklists.ultimo_rollover_dia is
  'Último "dia operacional" (ver corte_dia) já fechado/resetado desta rotina. Controle interno do rollover — não editar manualmente.';

drop trigger if exists checklists_set_updated_at on checklists;
create trigger checklists_set_updated_at
  before update on checklists
  for each row execute function public.set_updated_at();

alter table checklists enable row level security;

create table if not exists checklist_items (
  id text primary key,
  checklist_id text not null references checklists (id) on delete cascade,
  titulo text not null,
  detalhe text,
  status text not null default 'pendente' check (status in ('pendente', 'concluido')),
  posicao integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  recorrencia text not null default 'semanal'
    check (recorrencia in ('semanal', 'quinzenal', 'mensal')),
  dias_semana smallint[] not null default '{0,1,2,3,4,5,6}',
  inicio date,
  min_anexos int not null default 0,
  anexos jsonb not null default '[]'::jsonb,
  tipo_tarefa text not null default 'checklist'
    check (tipo_tarefa in ('checklist', 'enquete')),
  resposta_opcoes jsonb not null default '[]'::jsonb,
  resposta text,
  justificativa text,
  turno text check (turno is null or turno in ('Manhã', 'Tarde', 'Noite')),
  horario_inicio time,
  horario_termino time,
  max_anexos int check (max_anexos is null or max_anexos >= 0),
  concluido_em timestamptz,
  constraint checklist_items_anexos_min_max
    check (max_anexos is null or max_anexos >= min_anexos)
);

create index if not exists checklist_items_checklist_id_idx on checklist_items (checklist_id);
create index if not exists checklist_items_checklist_id_posicao_idx on checklist_items (checklist_id, posicao);

drop trigger if exists checklist_items_set_updated_at on checklist_items;
create trigger checklist_items_set_updated_at
  before update on checklist_items
  for each row execute function public.set_updated_at();

alter table checklist_items enable row level security;

-- ----------------------------------------------------------------------------
-- Login + papéis (admin / funcionario) + permissões individuais
-- ----------------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nome text not null,
  email text not null,
  role text not null default 'funcionario' check (role in ('admin', 'funcionario')),
  permissoes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists profiles_set_updated_at on profiles;
create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function public.set_updated_at();

-- Cria o perfil automaticamente quando um usuário é criado no Auth (usado pela
-- server function que cadastra funcionários com auth.admin.createUser).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, nome, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'nome', new.email),
    new.email,
    coalesce(new.raw_user_meta_data ->> 'role', 'funcionario')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- security definer para evitar recursão de RLS ao checar o papel do usuário
-- logado dentro das próprias policies de profiles/checklists/checklist_items.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- O usuário logado é admin OU tem a permissão pedida individualmente.
create or replace function public.tem_acesso(chave text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and (role = 'admin' or chave = any (permissoes))
  );
$$;

alter table profiles enable row level security;

drop policy if exists "ver o proprio perfil" on profiles;
create policy "ver o proprio perfil"
  on profiles for select
  to authenticated
  using (id = auth.uid());

drop policy if exists "ve todos os perfis" on profiles;
create policy "ve todos os perfis"
  on profiles for select
  to authenticated
  using (public.tem_acesso('cadastrar_funcionarios'));

drop policy if exists "atualiza perfis" on profiles;
create policy "atualiza perfis"
  on profiles for update
  to authenticated
  using (public.tem_acesso('cadastrar_funcionarios'))
  with check (public.tem_acesso('cadastrar_funcionarios'));

-- Anti-escalonamento: mesmo com 'cadastrar_funcionarios', um não-admin não
-- pode mexer em role/permissoes (nem se promover, nem promover outra conta).
-- A server function usa a service role key (auth.uid() nulo) e passa direto.
create or replace function public.profiles_guard_cargo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new; -- service role (server function que cadastra/edita funcionários)
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.role is distinct from old.role
    or new.permissoes is distinct from old.permissoes
  then
    raise exception 'Apenas administradores podem alterar cargo e permissões.';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_cargo on profiles;
create trigger profiles_guard_cargo
  before update on profiles
  for each row execute function public.profiles_guard_cargo();

-- ----------------------------------------------------------------------------
-- RLS: checklists / checklist_items
-- ----------------------------------------------------------------------------
drop policy if exists "autenticados veem checklists" on checklists;
create policy "autenticados veem checklists"
  on checklists for select
  to authenticated
  using (true);

drop policy if exists "cria checklists" on checklists;
create policy "cria checklists"
  on checklists for insert
  to authenticated
  with check (public.tem_acesso('criar_checklist'));

drop policy if exists "atualiza checklists" on checklists;
create policy "atualiza checklists"
  on checklists for update
  to authenticated
  using (public.tem_acesso('criar_checklist'))
  with check (public.tem_acesso('criar_checklist'));

drop policy if exists "remove checklists" on checklists;
create policy "remove checklists"
  on checklists for delete
  to authenticated
  using (public.tem_acesso('criar_checklist'));

drop policy if exists "autenticados veem itens" on checklist_items;
create policy "autenticados veem itens"
  on checklist_items for select
  to authenticated
  using (true);

drop policy if exists "insere itens" on checklist_items;
create policy "insere itens"
  on checklist_items for insert
  to authenticated
  with check (public.tem_acesso('criar_checklist'));

-- Update fica liberado para qualquer autenticado (funcionário precisa marcar
-- item concluído/pendente); os triggers abaixo reforçam quem pode alterar o quê.
drop policy if exists "autenticados atualizam itens" on checklist_items;
create policy "autenticados atualizam itens"
  on checklist_items for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "remove itens" on checklist_items;
create policy "remove itens"
  on checklist_items for delete
  to authenticated
  using (public.tem_acesso('criar_checklist'));

-- ============================================================================
-- Recorrência por atividade
-- ============================================================================
-- Regra "a atividade roda na data D", compartilhada pelo rollover e pelos
-- triggers:
--   semanal   -> dow(D) ∈ dias_semana
--   quinzenal -> D >= inicio e (D - inicio) múltiplo de 14
--   mensal    -> D >= inicio e dia(D) = min(dia(inicio), último dia do mês de D)
create or replace function public.item_roda_no_dia(
  p_recorrencia text,
  p_dias_semana smallint[],
  p_inicio date,
  p_alvo date
) returns boolean
language sql
immutable
as $$
  select case p_recorrencia
    when 'semanal' then
      extract(dow from p_alvo)::int = any (coalesce(p_dias_semana, '{}'::smallint[]))
    when 'quinzenal' then
      p_inicio is not null and p_alvo >= p_inicio and ((p_alvo - p_inicio) % 14) = 0
    when 'mensal' then
      p_inicio is not null and p_alvo >= p_inicio
      and extract(day from p_alvo)::int = least(
        extract(day from p_inicio)::int,
        extract(day from (date_trunc('month', p_alvo) + interval '1 month' - interval '1 day'))::int
      )
    else false
  end
$$;

-- ----------------------------------------------------------------------------
-- Dia sem expediente (feriado / loja fechada) — pausa TODAS as rotinas
-- ----------------------------------------------------------------------------
create table if not exists dias_desativados (
  data date primary key,
  criado_por uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table dias_desativados enable row level security;

drop policy if exists "autenticados veem dias desativados" on dias_desativados;
create policy "autenticados veem dias desativados"
  on dias_desativados for select
  to authenticated
  using (true);

drop policy if exists "desativa dia" on dias_desativados;
create policy "desativa dia"
  on dias_desativados for insert
  to authenticated
  with check (public.tem_acesso('pausar_dias'));

drop policy if exists "reativa dia" on dias_desativados;
create policy "reativa dia"
  on dias_desativados for delete
  to authenticated
  using (public.tem_acesso('pausar_dias'));

-- ----------------------------------------------------------------------------
-- Dia operacional por rotina (suporta corte_dia para turnos noturnos)
-- ----------------------------------------------------------------------------
create or replace function public.dia_operacional_checklist(corte time)
returns date
language sql
stable
as $$
  select case
    when corte is null then (now() at time zone 'America/Sao_Paulo')::date
    when (now() at time zone 'America/Sao_Paulo')::time < corte
      then (now() at time zone 'America/Sao_Paulo')::date - 1
    else (now() at time zone 'America/Sao_Paulo')::date
  end;
$$;

-- ----------------------------------------------------------------------------
-- Travas de escrita em checklist_items
-- ----------------------------------------------------------------------------
-- Trava a marcação de itens fora do dia da rotina: dia globalmente desativado,
-- rotina de folga hoje, ou atividade cuja recorrência não cai hoje. Admin e
-- quem tem 'criar_checklist' passam (editam a config em qualquer dia); o
-- rollover/reabertura automática passam pelo GUC app.bypass_item_guard.
create or replace function public.checklist_items_block_on_disabled_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rotina record;
  dia_op date;
begin
  if coalesce(current_setting('app.bypass_item_guard', true), '') = 'on' then
    return new;
  end if;

  if public.is_admin() or public.tem_acesso('criar_checklist') then
    return new;
  end if;

  select corte_dia, dias_pausados into rotina from public.checklists where id = new.checklist_id;
  dia_op := public.dia_operacional_checklist(rotina.corte_dia);

  if exists (select 1 from public.dias_desativados where data = dia_op) then
    raise exception 'As rotinas de hoje estão desativadas. Fale com o administrador.';
  end if;

  if dia_op = any(rotina.dias_pausados) then
    raise exception 'Esta rotina está de folga hoje.';
  end if;

  if not public.item_roda_no_dia(new.recorrencia, new.dias_semana, new.inicio, dia_op) then
    raise exception 'Esta atividade não está programada para hoje.';
  end if;

  return new;
end;
$$;

drop trigger if exists checklist_items_block_on_disabled_day on checklist_items;
create trigger checklist_items_block_on_disabled_day
  before update on checklist_items
  for each row execute function public.checklist_items_block_on_disabled_day();

-- Campos de configuração da tarefa (título, recorrência, anexos, enquete,
-- turno/horário...) só-admin ou quem tem 'criar_checklist'; execução
-- (status/anexos/resposta/justificativa) só o responsável da rotina, a menos
-- que tenha 'marcar_checklists_outros'; reabrir uma tarefa concluída exige
-- 'reabrir_rotina'; conclusão exige o mínimo de anexos e, na enquete, resposta
-- e justificativa preenchidas.
create or replace function public.checklist_items_restrict_funcionario_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meu_nome text;
  resp_rotina text;
begin
  -- rollover diário / reabertura automática reiniciam status/anexos em massa
  if coalesce(current_setting('app.bypass_item_guard', true), '') = 'on' then
    return new;
  end if;

  -- admin ou quem pode criar/editar checklists mexe em qualquer campo
  if public.is_admin() or public.tem_acesso('criar_checklist') then
    return new;
  end if;

  -- Reabrir (concluido -> pendente) exige admin ou a permissão específica.
  if old.status = 'concluido' and new.status = 'pendente'
    and not public.tem_acesso('reabrir_rotina')
  then
    raise exception 'Apenas administradores podem reabrir uma tarefa concluída.';
  end if;

  if new.titulo is distinct from old.titulo
    or new.detalhe is distinct from old.detalhe
    or new.posicao is distinct from old.posicao
    or new.checklist_id is distinct from old.checklist_id
    or new.min_anexos is distinct from old.min_anexos
    or new.max_anexos is distinct from old.max_anexos
    or new.recorrencia is distinct from old.recorrencia
    or new.dias_semana is distinct from old.dias_semana
    or new.inicio is distinct from old.inicio
    or new.tipo_tarefa is distinct from old.tipo_tarefa
    or new.resposta_opcoes is distinct from old.resposta_opcoes
    or new.turno is distinct from old.turno
    or new.horario_inicio is distinct from old.horario_inicio
    or new.horario_termino is distinct from old.horario_termino
  then
    raise exception 'Apenas administradores podem editar os itens da checklist.';
  end if;

  if new.status is distinct from old.status
    or new.anexos is distinct from old.anexos
    or new.resposta is distinct from old.resposta
    or new.justificativa is distinct from old.justificativa
  then
    -- 'marcar_checklists_outros' libera marcar item de qualquer rotina, sem
    -- precisar ser o responsável (mas continua sem poder editar a estrutura
    -- da checklist — bloqueado no if acima — nem reabrir sem 'reabrir_rotina').
    if not public.tem_acesso('marcar_checklists_outros') then
      select nome into meu_nome from public.profiles where id = auth.uid();
      select responsavel into resp_rotina from public.checklists where id = old.checklist_id;

      if meu_nome is null or lower(trim(meu_nome)) is distinct from lower(trim(resp_rotina)) then
        raise exception 'Você só pode marcar itens atribuídos a você.';
      end if;
    end if;
  end if;

  if new.max_anexos is not null
    and coalesce(jsonb_array_length(new.anexos), 0) > new.max_anexos
  then
    raise exception 'Envie no máximo % arquivo(s) neste item.', new.max_anexos;
  end if;

  if new.status = 'concluido' and new.status is distinct from old.status then
    if coalesce(jsonb_array_length(new.anexos), 0) < new.min_anexos then
      raise exception 'Anexe pelo menos % arquivo(s) para concluir esta tarefa.', new.min_anexos;
    end if;
    if new.tipo_tarefa = 'enquete' and coalesce(btrim(new.resposta), '') = '' then
      raise exception 'Escolha uma resposta para concluir esta enquete.';
    end if;
    if new.tipo_tarefa = 'enquete' and coalesce(btrim(new.justificativa), '') = '' then
      raise exception 'Preencha a justificativa para concluir esta enquete.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists checklist_items_restrict_funcionario_update on checklist_items;
create trigger checklist_items_restrict_funcionario_update
  before update on checklist_items
  for each row execute function public.checklist_items_restrict_funcionario_update();

-- Registra QUANDO cada atividade foi concluída (carimbado pelo banco, não
-- pelo client), pra distinguir depois "concluída no prazo" de "atrasada".
-- Zera de novo ao reabrir.
create or replace function public.checklist_items_stamp_concluido_em()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    new.concluido_em := case when new.status = 'concluido' then now() else null end;
  end if;
  return new;
end;
$$;

drop trigger if exists checklist_items_stamp_concluido_em on checklist_items;
create trigger checklist_items_stamp_concluido_em
  before update on checklist_items
  for each row execute function public.checklist_items_stamp_concluido_em();

-- ============================================================================
-- Histórico de rotinas + reset diário automático (rollover)
-- ============================================================================
-- Cada rotina "vira o dia" no seu próprio horário (meia-noite local, ou
-- corte_dia quando definido — turnos que atravessam a virada):
--   1. o estado do dia operacional que acabou é congelado em checklist_execucoes;
--   2. os itens daquela rotina voltam para 'pendente'.
--
-- Quem dispara: um job do pg_cron (caminho normal) e, como rede de segurança,
-- o próprio client chamando rollover_pendente() ao abrir o app. A função é
-- idempotente (trava por advisory lock + marca checklists.ultimo_rollover_dia
-- por rotina), então rodar de novo no mesmo dia operacional não faz nada.

-- Controle legado de "já fechei esse dia" (pré-corte_dia, quando o reset ainda
-- era global). Mantido por compatibilidade; o controle atual é por rotina, em
-- checklists.ultimo_rollover_dia.
create table if not exists app_estado (
  chave text primary key,
  valor text not null,
  atualizado_em timestamptz not null default now()
);

alter table app_estado enable row level security;
-- app_estado é interno (só as funções security definer mexem) — sem policy.

create table if not exists checklist_execucoes (
  id uuid primary key default gen_random_uuid(),
  -- sem FK para checklists: o registro sobrevive à exclusão da rotina
  checklist_id text not null,
  data date not null,
  nome text not null,
  turno text,
  horario time,
  total_itens integer not null default 0,
  itens_concluidos integer not null default 0,
  completa boolean not null default false,
  itens jsonb not null default '[]',
  registrado_em timestamptz not null default now(),
  unique (checklist_id, data)
);

create index if not exists checklist_execucoes_data_idx on checklist_execucoes (data);

alter table checklist_execucoes enable row level security;

drop policy if exists "ve execucoes" on checklist_execucoes;
create policy "ve execucoes"
  on checklist_execucoes for select
  to authenticated
  using (public.tem_acesso('ver_historico'));

-- ---------------------------------------------------------------------------
-- Snapshot do dia operacional fechado de UMA rotina.
-- ---------------------------------------------------------------------------
create or replace function public.rollover_snapshot_checklist(
  alvo_checklist_id text,
  alvo date,
  usar_estado boolean
)
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
          'anexos', case when usar_estado then ci.anexos else '[]'::jsonb end,
          'concluido_em', case when usar_estado then ci.concluido_em else null end
        ) order by ci.posicao
      ),
      '[]'
    )
  from checklists c
  join checklist_items ci on ci.checklist_id = c.id
    and public.item_roda_no_dia(ci.recorrencia, ci.dias_semana, ci.inicio, alvo)
  where c.id = alvo_checklist_id
    and not exists (select 1 from dias_desativados dd where dd.data = alvo)
  group by c.id
  on conflict (checklist_id, data) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rollover diário — por rotina, cada uma no seu dia operacional.
-- ---------------------------------------------------------------------------
create or replace function public.rollover_pendente()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  dia_op date;
  d date;
begin
  -- serializa chamadas concorrentes (vários clients abrindo o app ao mesmo tempo)
  perform pg_advisory_xact_lock(hashtext('rollover_checklists'));
  perform set_config('app.bypass_item_guard', 'on', true);

  for c in select id, corte_dia, ultimo_rollover_dia from checklists where ativo loop
    dia_op := public.dia_operacional_checklist(c.corte_dia);

    if c.ultimo_rollover_dia is null then
      -- primeira execução desta rotina: nada a fechar ainda, só marca o ponto de partida
      update checklists set ultimo_rollover_dia = dia_op where id = c.id;
      continue;
    end if;

    if c.ultimo_rollover_dia >= dia_op then
      continue; -- ainda no mesmo dia operacional dessa rotina (turno em andamento)
    end if;

    -- fecha o último dia ativo dela com o estado real dos itens...
    perform public.rollover_snapshot_checklist(c.id, c.ultimo_rollover_dia, true);
    -- ...e eventuais dias no meio (ninguém abriu o app e o cron ficou fora do ar)
    d := c.ultimo_rollover_dia + 1;
    while d < dia_op loop
      perform public.rollover_snapshot_checklist(c.id, d, false);
      d := d + 1;
    end loop;

    update checklist_items ci
       set status = 'pendente', anexos = '[]'::jsonb, resposta = null, justificativa = null
     where ci.checklist_id = c.id
       and (ci.status <> 'pendente'
            or ci.anexos <> '[]'::jsonb
            or ci.resposta is not null
            or ci.justificativa is not null);

    update checklists set ultimo_rollover_dia = dia_op where id = c.id;
  end loop;
end;
$$;

grant execute on function public.rollover_pendente() to authenticated;

-- ---------------------------------------------------------------------------
-- Reabertura automática (intra-dia) — controles como Segurança "a cada 20
-- minutos". Não gera histórico por ciclo; o snapshot continua sendo 1 por dia
-- operacional, no rollover.
-- ---------------------------------------------------------------------------
create or replace function public.reabrir_automaticas()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  dia_op date;
begin
  perform pg_advisory_xact_lock(hashtext('reabrir_automaticas'));
  perform set_config('app.bypass_item_guard', 'on', true);

  for c in
    select id, corte_dia, reabre_intervalo_min, reaberta_em
      from checklists
     where ativo
       and reabre_automatico
       and reabre_intervalo_min is not null
  loop
    dia_op := public.dia_operacional_checklist(c.corte_dia);

    -- Feriado / dia sem expediente (no dia operacional dessa rotina): não reabre.
    if exists (select 1 from dias_desativados where data = dia_op) then
      continue;
    end if;

    if c.reaberta_em is not null
       and now() - c.reaberta_em < make_interval(mins => c.reabre_intervalo_min)
    then
      continue;
    end if;

    update checklist_items ci
       set status = 'pendente', anexos = '[]'::jsonb, resposta = null, justificativa = null
     where ci.checklist_id = c.id
       and public.item_roda_no_dia(ci.recorrencia, ci.dias_semana, ci.inicio, dia_op)
       and (ci.status <> 'pendente'
            or ci.anexos <> '[]'::jsonb
            or ci.resposta is not null
            or ci.justificativa is not null);

    update checklists set reaberta_em = now() where id = c.id;
  end loop;
end;
$$;

grant execute on function public.reabrir_automaticas() to authenticated;

-- ============================================================================
-- Notificação por e-mail: rotina concluída / rotina atrasada
-- ============================================================================
-- E-mail via Resend, chamado com a extensão http (síncrono, só marca como
-- enviado numa resposta 2xx de verdade) com fallback best-effort em pg_net.
-- Credenciais ficam no Vault, não em texto puro:
--
--   select vault.update_secret(id, 'sua-api-key-da-resend')
--     from vault.secrets where name = 'resend_api_key';
--   select vault.update_secret(id, 'G-Check <notificacoes@seudominio.com.br>')
--     from vault.secrets where name = 'resend_from_email';
--
-- Enquanto resend_api_key ficar no valor placeholder, notificar_rotinas() não
-- faz nada (return antecipado) — seguro rodar esta migration antes de
-- configurar a conta na Resend.

do $$
begin
  execute 'create extension if not exists pg_net';
exception when others then
  raise notice 'pg_net indisponivel (%). Notificacao por e-mail nao vai funcionar.', sqlerrm;
end;
$$;

do $$
begin
  execute 'create extension if not exists supabase_vault';
exception when others then
  raise notice 'supabase_vault indisponivel (%). Notificacao por e-mail nao vai funcionar.', sqlerrm;
end;
$$;

do $$
begin
  execute 'create extension if not exists http with schema extensions';
exception when others then
  raise notice 'extensao http indisponivel (%). resend_enviar() vai cair no modo best-effort via pg_net.', sqlerrm;
end;
$$;

-- Segredos (placeholder até você configurar de verdade — ver instruções acima).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'resend_api_key') then
    perform vault.create_secret(
      'SUBSTITUA_PELA_SUA_API_KEY',
      'resend_api_key',
      'API key da Resend usada por notificar_rotinas() para enviar e-mail de rotina concluida/atrasada.'
    );
  end if;
  if not exists (select 1 from vault.secrets where name = 'resend_from_email') then
    perform vault.create_secret(
      'G-Check <onboarding@resend.dev>',
      'resend_from_email',
      'Remetente usado nos e-mails de notificacao (troque pelo seu dominio verificado na Resend).'
    );
  end if;
  if not exists (select 1 from vault.secrets where name = 'app_url') then
    perform vault.create_secret(
      'https://felix-matriz.g-check.workers.dev/',
      'app_url',
      'URL do sistema em producao — usada no botao "Abrir o sistema" e pra montar o link das logos no e-mail. Termina com barra.'
    );
  end if;
  if not exists (select 1 from vault.secrets where name = 'suporte_email') then
    perform vault.create_secret(
      'g-check@germanoconsultoria.com.br',
      'suporte_email',
      'E-mail de contato mostrado no rodape dos e-mails de notificacao.'
    );
  end if;
exception when others then
  raise notice 'Vault indisponivel (%). Configure os segredos manualmente depois.', sqlerrm;
end;
$$;

-- Controle de envio (1 e-mail por rotina/dia/tipo).
create table if not exists checklist_notificacoes (
  -- sem FK para checklists: sobrevive à exclusão da rotina, como checklist_execucoes
  checklist_id text not null,
  data date not null,
  tipo text not null check (tipo in ('concluida', 'atrasada')),
  enviado_em timestamptz not null default now(),
  primary key (checklist_id, data, tipo)
);

alter table checklist_notificacoes enable row level security;
-- Tabela interna (só notificar_rotinas() mexe nela, via security definer) — sem policy.

-- Template do e-mail: identidade da marca Félix — cabeçalho vermelho/amarelo
-- com a logo no meio, título com nome/status/responsável/data, texto
-- explicativo, contagem, lista de atividades atrasadas (só quando houver),
-- botão pro sistema e rodapé com contato de suporte + logo G-Tech.
create or replace function public.notificar_email_html(
  p_status text,          -- 'ATRASADA' ou 'CONCLUÍDA' (etiqueta acima do título)
  p_nome text,             -- nome da rotina
  p_responsavel text,
  p_data text,              -- 'DD/MM/YYYY'
  p_hora text,               -- 'HH:MM'
  p_mensagem text,            -- texto explicativo
  p_contagem_label text,       -- ex.: '27 de 74 atividades atrasadas'
  p_pendentes text[],           -- títulos das atividades atrasadas (null/{} = sem lista)
  p_url text,
  p_suporte_email text,
  p_logo_felix text,
  p_logo_gtech text
) returns text
language plpgsql
immutable
as $$
declare
  lista_html text := '';
  itens_html text;
  max_itens constant int := 12;
  qtd_pendentes int := coalesce(array_length(p_pendentes, 1), 0);
begin
  if qtd_pendentes > 0 then
    select string_agg(format('<li style="margin:0 0 4px;">%s</li>', item), '')
      into itens_html
      from unnest(p_pendentes[1:max_itens]) as item;

    if qtd_pendentes > max_itens then
      itens_html := itens_html || format(
        '<li style="color:#8A8A8A;">+ %s outra(s)</li>',
        qtd_pendentes - max_itens
      );
    end if;

    lista_html := format(
      '<tr><td style="padding:10px 28px 0;">' ||
      '<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8;color:#333333;">%s</ul>' ||
      '</td></tr>',
      itens_html
    );
  end if;

  return
    '<!DOCTYPE html><html lang="pt-BR"><body style="margin:0;padding:0;background-color:#F0F0F0;' ||
    'font-family:Arial,Helvetica,sans-serif;">' ||
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' ||
    'style="background-color:#F0F0F0;padding:24px 12px;"><tr><td align="center">' ||
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' ||
    'style="max-width:560px;width:100%;background-color:#FFFFFF;border:1px solid #E5E5E5;">' ||

    -- Cabeçalho: |----vermelho----|amarelo + logo Félix|----vermelho----|
    '<tr><td style="padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' ||
    '<td width="20%" style="background-color:#BF2020;height:72px;font-size:0;line-height:0;">&nbsp;</td>' ||
    '<td width="60%" style="background-color:#FFDA24;text-align:center;padding:10px 0;">' ||
    format('<img src="%s" width="90" alt="Felix Matriz" style="display:inline-block;">', p_logo_felix) ||
    '</td>' ||
    '<td width="20%" style="background-color:#BF2020;height:72px;font-size:0;line-height:0;">&nbsp;</td>' ||
    '</tr></table></td></tr>' ||

    -- Título: nome da rotina, status, responsável, data/hora
    format(
      '<tr><td style="padding:28px 28px 0;">' ||
      '<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.06em;' ||
      'text-transform:uppercase;color:#BF2020;">%s</p>' ||
      '<h1 style="margin:0 0 4px;font-size:21px;line-height:1.3;color:#1A1A1A;">%s</h1>' ||
      '<p style="margin:0;font-size:13px;color:#767676;">Responsável: %s &middot; %s &agrave;s %s</p>' ||
      '</td></tr>',
      p_status, p_nome, p_responsavel, p_data, p_hora
    ) ||

    -- Texto explicativo
    format(
      '<tr><td style="padding:16px 28px 0;">' ||
      '<p style="margin:0;font-size:14px;line-height:1.6;color:#333333;">%s</p>' ||
      '</td></tr>',
      p_mensagem
    ) ||

    -- Contagem (quantas de quantas)
    format(
      '<tr><td style="padding:20px 28px 0;">' ||
      '<p style="margin:0;font-size:15px;font-weight:700;color:#BF2020;">%s</p>' ||
      '</td></tr>',
      p_contagem_label
    ) ||

    -- Lista de atividades atrasadas (vazia = nada, ex.: rotina concluída)
    lista_html ||

    -- Botão: abrir o sistema
    format(
      '<tr><td style="padding:28px;">' ||
      '<a href="%s" style="display:inline-block;background-color:#BF2020;color:#FFFFFF;' ||
      'font-size:14px;font-weight:700;text-decoration:none;padding:12px 24px;">Abrir o sistema</a>' ||
      '</td></tr>',
      p_url
    ) ||

    -- Rodapé: suporte + logo G-Tech
    format(
      '<tr><td style="padding:20px 28px;background-color:#FAFAFA;border-top:1px solid #E5E5E5;">' ||
      '<table role="presentation" width="100%%" cellpadding="0" cellspacing="0"><tr>' ||
      '<td style="vertical-align:middle;"><p style="margin:0;font-size:12px;color:#767676;">' ||
      'Precisa de suporte? Entre em contato: <a href="mailto:%s" style="color:#BF2020;">%s</a></p></td>' ||
      '<td width="50" style="text-align:right;vertical-align:middle;">' ||
      '<img src="%s" width="36" alt="G-Tech"></td>' ||
      '</tr></table></td></tr>',
      p_suporte_email, p_suporte_email, p_logo_gtech
    ) ||

    '</table></td></tr></table></body></html>';
end;
$$;

-- Envio: chamada síncrona à Resend via extensão http — só retorna true (e só
-- aí notificar_rotinas() marca como enviado) quando a Resend responde 2xx de
-- verdade. Se a extensão http não estiver disponível, cai pro pg_net "solto"
-- (best-effort) em vez de travar o job inteiro.
create or replace function public.resend_enviar(
  p_api_key text,
  p_from text,
  p_destinatarios text[],
  p_assunto text,
  p_html text
) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  corpo jsonb;
  resp http_response;
  ok boolean;
begin
  corpo := jsonb_build_object(
    'from', p_from,
    'to', to_jsonb(p_destinatarios),
    'subject', p_assunto,
    'html', p_html
  );

  begin
    select * into resp from http((
      'POST',
      'https://api.resend.com/emails',
      ARRAY[http_header('Authorization', 'Bearer ' || p_api_key)],
      'application/json',
      corpo::text
    )::http_request);
    ok := resp.status between 200 and 299;
  exception when others then
    -- extensão http indisponível/erro inesperado: dispara sem confirmação
    -- (comportamento antigo) em vez de deixar a rotina sem notificar.
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || p_api_key,
        'Content-Type', 'application/json'
      ),
      body := corpo
    );
    ok := true;
  end;

  return coalesce(ok, false);
end;
$$;

-- Checagem + envio. "Concluída"/"atrasada" usam a mesma regra da tela
-- (src/lib/g-check-store.tsx): limite = tempo_limite manual, ou o maior
-- horario_termino cadastrado entre os itens da rotina. Rotina de folga hoje
-- (dias_pausados) ou sem nenhum item hoje não entra na checagem.
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

-- ----------------------------------------------------------------------------
-- Expõe só os NOMES das contas admin (sem email/permissões) pra qualquer
-- autenticado, via função security definer — contorna a RLS de profiles sem
-- abrir a tabela inteira. Usado em /checklists para esconder de personalizados
-- as rotinas cujo responsável é uma conta admin.
-- ----------------------------------------------------------------------------
create or replace function public.nomes_admin()
returns table (nome text)
language sql
stable
security definer
set search_path = public
as $$
  select p.nome from public.profiles p where p.role = 'admin';
$$;

grant execute on function public.nomes_admin() to authenticated;

-- ============================================================================
-- Storage: bucket das fotos de comprovação das tarefas
-- ============================================================================
-- Público na leitura (a URL pública é guardada em checklist_items.anexos e
-- reexibida no histórico); escrita só para usuário autenticado — a trava de
-- "só o responsável anexa" já é feita no update de checklist_items.
insert into storage.buckets (id, name, public)
values ('checklist-fotos', 'checklist-fotos', true)
on conflict (id) do update set public = true;

drop policy if exists "checklist-fotos leitura publica" on storage.objects;
create policy "checklist-fotos leitura publica"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'checklist-fotos');

drop policy if exists "checklist-fotos upload autenticado" on storage.objects;
create policy "checklist-fotos upload autenticado"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'checklist-fotos');

drop policy if exists "checklist-fotos update autenticado" on storage.objects;
create policy "checklist-fotos update autenticado"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'checklist-fotos')
  with check (bucket_id = 'checklist-fotos');

drop policy if exists "checklist-fotos delete autenticado" on storage.objects;
create policy "checklist-fotos delete autenticado"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'checklist-fotos');

-- ============================================================================
-- Agendamento (pg_cron) — best effort; se indisponível no plano do projeto,
-- os fallbacks do client (GCheckProvider) cobrem os três jobs.
-- ============================================================================
do $$
begin
  execute 'create extension if not exists pg_cron';

  perform cron.schedule(
    'rollover-checklists-diario',
    '*/5 * * * *',
    'select public.rollover_pendente()'
  );

  perform cron.schedule(
    'reabrir-rotinas-automaticas',
    '* * * * *',
    'select public.reabrir_automaticas()'
  );

  perform cron.schedule(
    'notificar-rotinas-email',
    '*/5 * * * *',
    'select public.notificar_rotinas()'
  );
exception when others then
  raise notice 'pg_cron nao configurado (%). Reset diario, reabertura e notificacao via fallback do client.', sqlerrm;
end;
$$;

-- ============================================================================
-- LOGIN INICIAL — admin@felixmatriz.com / Admin@2026 (papel admin)
-- Único usuário criado. Demais funcionários entram pelo app (tela Funcionários).
-- ============================================================================

do $$
declare
  v_email text := 'admin@felixmatriz.com';
  v_senha text := 'Admin@2026';
  v_nome  text := 'Administrador';
  v_uid   uuid;
begin
  select id into v_uid from auth.users where email = v_email;

  if v_uid is null then
    v_uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      -- O GoTrue lê estas colunas como texto não-anulável; inseridas via SQL
      -- elas ficariam NULL e o login quebraria com "Database error querying
      -- schema". Precisam ser string vazia.
      confirmation_token, recovery_token, email_change,
      email_change_token_new, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email,
      crypt(v_senha, gen_salt('bf')), now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('nome', v_nome, 'role', 'admin'),
      now(), now(),
      '', '', '',
      '', '',
      '', '', ''
    );

    insert into auth.identities (
      provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      v_uid::text, v_uid,
      jsonb_build_object(
        'sub', v_uid::text, 'email', v_email,
        'email_verified', true, 'phone_verified', false
      ),
      'email', now(), now(), now()
    );
  else
    -- já existe: só redefine a senha e confirma o e-mail
    update auth.users
       set encrypted_password = crypt(v_senha, gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           raw_user_meta_data = jsonb_build_object('nome', v_nome, 'role', 'admin'),
           updated_at = now(),
           -- normaliza NULLs herdados de inserts SQL antigos (ver comentário acima)
           confirmation_token         = coalesce(confirmation_token, ''),
           recovery_token             = coalesce(recovery_token, ''),
           email_change               = coalesce(email_change, ''),
           email_change_token_new     = coalesce(email_change_token_new, ''),
           email_change_token_current = coalesce(email_change_token_current, ''),
           phone_change               = coalesce(phone_change, ''),
           phone_change_token         = coalesce(phone_change_token, ''),
           reauthentication_token     = coalesce(reauthentication_token, '')
     where id = v_uid;
  end if;

  -- o trigger handle_new_user() cria a linha em profiles; garante o papel admin
  insert into public.profiles (id, nome, email, role)
  values (v_uid, v_nome, v_email, 'admin')
  on conflict (id) do update
    set role = 'admin', nome = v_nome, email = v_email;
end $$;

-- Conferência
select u.email, p.role, u.email_confirmed_at is not null as email_confirmado
from auth.users u
join public.profiles p on p.id = u.id;
