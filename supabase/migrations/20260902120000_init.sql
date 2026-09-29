-- ============================================================================
-- G-Check-Felix-Matriz — migration inicial (Felix Matriz)
-- ----------------------------------------------------------------------------
-- Baseline única: cria TODO o schema (tabelas, funções, triggers, RLS,
-- storage bucket) e o único login inicial admin@felixmatriz.com.
-- Consolida o histórico antigo do G-Check; o banco começa sem dados de
-- demonstração (nenhuma checklist, item ou setor).
-- ============================================================================

create extension if not exists pgcrypto;


-- ----------------------------------------------------------------------------
-- [20260822120000_init_checksup_schema.sql]
-- ----------------------------------------------------------------------------
-- G-check: rotinas operacionais de supermercado
-- Modelo extraído de src/lib/g-check-store.tsx (Checklist / ChecklistItem)

create extension if not exists pgcrypto;

create table if not exists checklists (
  id text primary key,
  nome text not null,
  setor text not null,
  turno text not null check (turno in ('Manhã', 'Tarde', 'Noite')),
  horario time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists checklist_items (
  id text primary key,
  checklist_id text not null references checklists (id) on delete cascade,
  titulo text not null,
  detalhe text,
  responsavel text not null,
  status text not null default 'pendente' check (status in ('pendente', 'concluido')),
  posicao integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists checklist_items_checklist_id_idx on checklist_items (checklist_id);
create index if not exists checklist_items_checklist_id_posicao_idx on checklist_items (checklist_id, posicao);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists checklists_set_updated_at on checklists;
create trigger checklists_set_updated_at
  before update on checklists
  for each row execute function set_updated_at();

drop trigger if exists checklist_items_set_updated_at on checklist_items;
create trigger checklist_items_set_updated_at
  before update on checklist_items
  for each row execute function set_updated_at();

-- RLS: app ainda não tem autenticação (chave anon fica exposta no frontend).
-- Liberado para anon como ambiente de demonstração; revisar antes de produção.
alter table checklists enable row level security;
alter table checklist_items enable row level security;

drop policy if exists "anon full access" on checklists;
create policy "anon full access"
  on checklists for all
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "anon full access" on checklist_items;
create policy "anon full access"
  on checklist_items for all
  to anon, authenticated
  using (true)
  with check (true);


-- ----------------------------------------------------------------------------
-- [20260822130000_add_auth_roles.sql]
-- ----------------------------------------------------------------------------
-- Login + papéis (admin / funcionário).
-- Só o admin pode criar contas de funcionário (via server function com service_role) e
-- criar/editar/apagar checklists. Funcionário só executa (marca item, conclui/reabre rotina).

create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nome text not null,
  email text not null,
  role text not null default 'funcionario' check (role in ('admin', 'funcionario')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists profiles_set_updated_at on profiles;
create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- Cria o perfil automaticamente quando um usuário é criado no Auth
-- (usado pela server function que cadastra funcionários com auth.admin.createUser).
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

-- security definer para evitar recursão de RLS ao checar o papel do usuário logado
-- dentro das próprias policies de profiles/checklists/checklist_items.
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

alter table profiles enable row level security;

drop policy if exists "ver o proprio perfil" on profiles;
create policy "ver o proprio perfil"
  on profiles for select
  to authenticated
  using (id = auth.uid());

drop policy if exists "admin ve todos os perfis" on profiles;
create policy "admin ve todos os perfis"
  on profiles for select
  to authenticated
  using (is_admin());

drop policy if exists "admin atualiza perfis" on profiles;
create policy "admin atualiza perfis"
  on profiles for update
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Substitui o acesso público (anon) das checklists por acesso restrito a
-- usuários autenticados; escrita (insert/update/delete) só para admin.
drop policy if exists "anon full access" on checklists;

create policy "autenticados veem checklists"
  on checklists for select
  to authenticated
  using (true);

create policy "admin cria checklists"
  on checklists for insert
  to authenticated
  with check (is_admin());

create policy "admin atualiza checklists"
  on checklists for update
  to authenticated
  using (is_admin())
  with check (is_admin());

create policy "admin remove checklists"
  on checklists for delete
  to authenticated
  using (is_admin());

drop policy if exists "anon full access" on checklist_items;

create policy "autenticados veem itens"
  on checklist_items for select
  to authenticated
  using (true);

create policy "admin insere itens"
  on checklist_items for insert
  to authenticated
  with check (is_admin());

-- Update fica liberado para qualquer autenticado (funcionário precisa marcar
-- item concluído/pendente); o trigger abaixo bloqueia funcionário alterando
-- título/detalhe/responsável/posição — só o status.
create policy "autenticados atualizam itens"
  on checklist_items for update
  to authenticated
  using (true)
  with check (true);

create policy "admin remove itens"
  on checklist_items for delete
  to authenticated
  using (is_admin());

create or replace function public.checklist_items_restrict_funcionario_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if new.titulo is distinct from old.titulo
    or new.detalhe is distinct from old.detalhe
    or new.responsavel is distinct from old.responsavel
    or new.posicao is distinct from old.posicao
    or new.checklist_id is distinct from old.checklist_id
  then
    raise exception 'Apenas administradores podem editar os itens da checklist.';
  end if;

  return new;
end;
$$;

drop trigger if exists checklist_items_restrict_funcionario_update on checklist_items;
create trigger checklist_items_restrict_funcionario_update
  before update on checklist_items
  for each row execute function public.checklist_items_restrict_funcionario_update();

-- Bootstrap do primeiro admin (rodar manualmente depois de criar o usuário pelo
-- Dashboard do Supabase em Authentication > Users, ou pela tela de login com uma
-- conta criada via server function):
--
--   update profiles set role = 'admin' where email = 'seu-email@dominio.com';


-- ----------------------------------------------------------------------------
-- [20260824140000_restrict_item_status_to_responsavel.sql]
-- ----------------------------------------------------------------------------
-- Funcionário só pode alterar o status de um item se ele for o responsável
-- por esse item (checagem por nome, já que checklist_items.responsavel é
-- texto livre — mesmo critério usado no frontend em
-- src/lib/g-check-store.tsx, função ehResponsavel).
-- Admin continua podendo alterar qualquer item, como antes.

create or replace function public.checklist_items_restrict_funcionario_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meu_nome text;
begin
  if public.is_admin() then
    return new;
  end if;

  if new.titulo is distinct from old.titulo
    or new.detalhe is distinct from old.detalhe
    or new.responsavel is distinct from old.responsavel
    or new.posicao is distinct from old.posicao
    or new.checklist_id is distinct from old.checklist_id
  then
    raise exception 'Apenas administradores podem editar os itens da checklist.';
  end if;

  if new.status is distinct from old.status then
    select nome into meu_nome from public.profiles where id = auth.uid();

    if meu_nome is null or lower(trim(meu_nome)) is distinct from lower(trim(old.responsavel)) then
      raise exception 'Você só pode marcar itens atribuídos a você.';
    end if;
  end if;

  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- [20260824150000_add_checklist_ativo.sql]
-- ----------------------------------------------------------------------------
-- Permite ativar/desativar uma rotina sem apagá-la. Rotinas inativas saem do
-- resumo operacional do dashboard e da visão do funcionário, mas continuam
-- editáveis pelo admin em /checklists.

alter table checklists add column if not exists ativo boolean not null default true;


-- ----------------------------------------------------------------------------
-- [20260827120000_add_setores.sql]
-- ----------------------------------------------------------------------------
-- ============================================================================
-- G-check — tabela de setores (rotina de cadastros)
-- ----------------------------------------------------------------------------
-- Cadastro próprio de setores, usado como referência ao criar/editar checklists.
-- Script idempotente: pode rodar mais de uma vez sem quebrar.
-- Depende de set_updated_at() e is_admin(), já criadas nas migrations anteriores
-- (ou no full_setup.sql).
-- ============================================================================

create table if not exists setores (
  id text primary key,
  nome text not null unique,
  descricao text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists setores_set_updated_at on setores;
create trigger setores_set_updated_at
  before update on setores
  for each row execute function set_updated_at();

-- RLS: todo autenticado lê; só admin escreve (mesmo padrão de checklists).
alter table setores enable row level security;

drop policy if exists "autenticados veem setores" on setores;
drop policy if exists "admin cria setores" on setores;
drop policy if exists "admin atualiza setores" on setores;
drop policy if exists "admin remove setores" on setores;

create policy "autenticados veem setores"
  on setores for select
  to authenticated
  using (true);

create policy "admin cria setores"
  on setores for insert
  to authenticated
  with check (is_admin());

create policy "admin atualiza setores"
  on setores for update
  to authenticated
  using (is_admin())
  with check (is_admin());

create policy "admin remove setores"
  on setores for delete
  to authenticated
  using (is_admin());


-- ----------------------------------------------------------------------------
-- [20260831120000_add_checklist_dias_semana.sql] (revisado em 20260904_recorrencia_por_item)
-- ----------------------------------------------------------------------------
-- Recorrência por ATIVIDADE (item), não por rotina:
--   recorrencia  'semanal' | 'quinzenal' | 'mensal'
--   dias_semana  smallint[] 0..6 (D S T Q Q S S) -> usado quando 'semanal'
--   inicio       date -> data de começo, usada quando 'quinzenal'/'mensal'
-- Default = semanal todos os dias, para as atividades já existentes seguirem
-- valendo todo dia sem ajuste manual.

alter table checklist_items
  add column if not exists recorrencia text not null default 'semanal'
    check (recorrencia in ('semanal', 'quinzenal', 'mensal')),
  add column if not exists dias_semana smallint[] not null default '{0,1,2,3,4,5,6}',
  add column if not exists inicio date;

-- Regra "a atividade roda na data D", compartilhada pelo rollover e pelos triggers.
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
-- [20260831130000_add_dias_desativados.sql]
-- ----------------------------------------------------------------------------
-- Feriado / dia sem expediente: marca um dia inteiro como desativado. Enquanto a
-- data de hoje estiver nesta tabela, o dashboard não cobra as pendências do dia.
-- É reversível (o admin apaga a linha para reativar) e não altera nenhuma
-- checklist — a recorrência por atividade (checklist_items.recorrencia) continua
-- valendo nos demais dias.

create table if not exists dias_desativados (
  data date primary key,
  criado_por uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table dias_desativados enable row level security;

drop policy if exists "autenticados veem dias desativados" on dias_desativados;
drop policy if exists "admin desativa dia" on dias_desativados;
drop policy if exists "admin reativa dia" on dias_desativados;

-- Todo autenticado lê (o funcionário também vê "rotinas pausadas hoje");
-- só admin desativa/reativa.
create policy "autenticados veem dias desativados"
  on dias_desativados for select
  to authenticated
  using (true);

create policy "admin desativa dia"
  on dias_desativados for insert
  to authenticated
  with check (is_admin());

create policy "admin reativa dia"
  on dias_desativados for delete
  to authenticated
  using (is_admin());


-- ----------------------------------------------------------------------------
-- [20260831140000_lock_checklist_items_on_disabled_day.sql]
-- ----------------------------------------------------------------------------
-- Trava a marcação de itens quando o dia de hoje está desativado (feriado).
-- Enquanto current_date estiver em dias_desativados, funcionários não conseguem
-- mudar o status de nenhum item — some com a "cobrança" e evita registro de
-- execução em dia sem expediente. O admin passa (mesma regra do trigger
-- checklist_items_restrict_funcionario_update): ele pode reativar o dia.

create or replace function public.checklist_items_block_on_disabled_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if exists (select 1 from public.dias_desativados where data = current_date) then
    raise exception 'As rotinas de hoje estão desativadas. Fale com o administrador.';
  end if;

  return new;
end;
$$;

drop trigger if exists checklist_items_block_on_disabled_day on checklist_items;
create trigger checklist_items_block_on_disabled_day
  before update on checklist_items
  for each row execute function public.checklist_items_block_on_disabled_day();


-- ----------------------------------------------------------------------------
-- [20260831150000_historico_e_rollover.sql]
-- ----------------------------------------------------------------------------
-- Histórico de rotinas + reset diário automático.
--
-- Todo dia à meia-noite (fuso America/Sao_Paulo) as checklists "viram o dia":
--   1. o estado do dia que acabou é congelado em checklist_execucoes;
--   2. checklist_items volta tudo para 'pendente'.
--
-- Quem dispara: um job do pg_cron (caminho normal) e, como rede de segurança,
-- o próprio client chamando rollover_pendente() ao abrir o app. A função é
-- idempotente (trava por advisory lock + marca app_estado.ultimo_rollover), então
-- rodar de novo no mesmo dia não faz nada.

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------
create table if not exists app_estado (
  chave text primary key,
  valor text not null,
  atualizado_em timestamptz not null default now()
);

create table if not exists checklist_execucoes (
  id uuid primary key default gen_random_uuid(),
  -- sem FK para checklists: o registro sobrevive à exclusão da rotina
  checklist_id text not null,
  data date not null,
  nome text not null,
  setor text not null,
  turno text not null,
  horario time not null,
  total_itens integer not null default 0,
  itens_concluidos integer not null default 0,
  completa boolean not null default false,
  itens jsonb not null default '[]',
  registrado_em timestamptz not null default now(),
  unique (checklist_id, data)
);

create index if not exists checklist_execucoes_data_idx on checklist_execucoes (data);

alter table app_estado enable row level security;
alter table checklist_execucoes enable row level security;

-- app_estado é interno (só as funções security definer mexem) — sem policy.
drop policy if exists "autenticados veem execucoes" on checklist_execucoes;
create policy "autenticados veem execucoes"
  on checklist_execucoes for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Bypass das travas de item durante o rollover
-- ---------------------------------------------------------------------------
-- O reset mexe no status de itens de todo mundo, o que os triggers
-- checklist_items_restrict_funcionario_update e checklist_items_block_on_disabled_day
-- barrariam. rollover_pendente() liga o GUC app.bypass_item_guard (escopo da
-- transação) e os triggers respeitam. Clientes via PostgREST não conseguem
-- chamar set_config, então não há como forjar esse bypass pela aplicação.

create or replace function public.checklist_items_restrict_funcionario_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meu_nome text;
begin
  if coalesce(current_setting('app.bypass_item_guard', true), '') = 'on' then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.titulo is distinct from old.titulo
    or new.detalhe is distinct from old.detalhe
    or new.responsavel is distinct from old.responsavel
    or new.posicao is distinct from old.posicao
    or new.checklist_id is distinct from old.checklist_id
  then
    raise exception 'Apenas administradores podem editar os itens da checklist.';
  end if;

  if new.status is distinct from old.status then
    select nome into meu_nome from public.profiles where id = auth.uid();

    if meu_nome is null or lower(trim(meu_nome)) is distinct from lower(trim(old.responsavel)) then
      raise exception 'Você só pode marcar itens atribuídos a você.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.checklist_items_block_on_disabled_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rollover
-- ---------------------------------------------------------------------------
-- Congela um dia em checklist_execucoes. "usar_estado" = usar o status atual dos
-- itens (dia normal, fechado no dia seguinte); false = dia sem execução (buraco
-- de vários dias sem rollover) -> registra como não realizado.
create or replace function public.rollover_snapshot_dia(alvo date, usar_estado boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into checklist_execucoes
    (checklist_id, data, nome, setor, turno, horario, total_itens, itens_concluidos, completa, itens)
  select
    c.id,
    alvo,
    c.nome,
    c.setor,
    c.turno,
    c.horario,
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
          'responsavel', ci.responsavel,
          'status', case when usar_estado then ci.status else 'pendente' end
        ) order by ci.posicao
      ),
      '[]'
    )
  from checklists c
  join checklist_items ci on ci.checklist_id = c.id
    and public.item_roda_no_dia(ci.recorrencia, ci.dias_semana, ci.inicio, alvo)
  where c.ativo
    and not exists (select 1 from dias_desativados dd where dd.data = alvo)
  group by c.id
  on conflict (checklist_id, data) do nothing;
end;
$$;

create or replace function public.rollover_pendente()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tz constant text := 'America/Sao_Paulo';
  hoje_local date := (now() at time zone tz)::date;
  ultimo date;
  d date;
begin
  -- serializa chamadas concorrentes (vários clients abrindo o app à meia-noite)
  perform pg_advisory_xact_lock(hashtext('rollover_checklists'));

  select valor::date into ultimo from app_estado where chave = 'ultimo_rollover';

  if ultimo is null then
    -- primeira execução: nada a fechar ainda, só marca o ponto de partida
    insert into app_estado (chave, valor) values ('ultimo_rollover', hoje_local::text)
      on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
    return;
  end if;

  if ultimo >= hoje_local then
    return; -- já virou o dia hoje
  end if;

  -- fecha o último dia ativo com o estado real dos itens...
  perform public.rollover_snapshot_dia(ultimo, true);
  -- ...e eventuais dias no meio (app ficou dias sem abrir e sem cron) como não realizados
  d := ultimo + 1;
  while d < hoje_local loop
    perform public.rollover_snapshot_dia(d, false);
    d := d + 1;
  end loop;

  -- reinicia os itens para o novo dia (bypass das travas — ver comentário acima)
  perform set_config('app.bypass_item_guard', 'on', true);
  update checklist_items set status = 'pendente' where status <> 'pendente';

  update app_estado set valor = hoje_local::text, atualizado_em = now()
    where chave = 'ultimo_rollover';
end;
$$;

grant execute on function public.rollover_pendente() to authenticated;

-- ---------------------------------------------------------------------------
-- Agendamento (pg_cron) — best effort
-- ---------------------------------------------------------------------------
-- 03h05 UTC ~= 00h05 America/Sao_Paulo (Brasil sem horário de verão, UTC-3). Se
-- o pg_cron não estiver disponível no projeto, o fallback do client cobre.
do $$
begin
  execute 'create extension if not exists pg_cron';
  perform cron.schedule(
    'rollover-checklists-diario',
    '5 3 * * *',
    'select public.rollover_pendente()'
  );
exception when others then
  raise notice 'pg_cron nao configurado (%). Reset diario via fallback do client.', sqlerrm;
end;
$$;


-- ----------------------------------------------------------------------------
-- [20260831160000_add_checklist_tempo_limite.sql]
-- ----------------------------------------------------------------------------
-- "Tempo limite": horário até o qual a rotina deveria estar concluída. Depois
-- dele, uma rotina ainda não finalizada passa a contar como "Atrasada" (novo
-- estado derivado no client — ver estado() em src/lib/g-check-store.tsx).
-- Opcional: rotina sem tempo_limite nunca fica atrasada.

alter table checklists add column if not exists tempo_limite time;


-- ----------------------------------------------------------------------------
-- [20260831170000_block_checklist_items_fora_do_dia.sql]
-- ----------------------------------------------------------------------------
-- Reforça no banco a regra "atividade desativada quando não é o dia dela": além
-- do dia pausado (dias_desativados), um funcionário não pode mexer no status de
-- uma atividade cuja recorrência (por item) não cai em hoje. Admin passa; o
-- rollover diário passa pelo GUC.

create or replace function public.checklist_items_block_on_disabled_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

  if not public.item_roda_no_dia(new.recorrencia, new.dias_semana, new.inicio, current_date) then
    raise exception 'Esta atividade não está programada para hoje.';
  end if;

  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- [20260831180000_historico_admin_only.sql]
-- ----------------------------------------------------------------------------
-- Histórico (checklist_execucoes) passa a ser leitura só de admin. Antes a
-- policy liberava SELECT para qualquer autenticado; a tela de Histórico agora é
-- exclusiva do admin (ver historico.tsx / app-shell.tsx), então a barreira de
-- dados acompanha. As funções de rollover são security definer e não dependem
-- desta policy.

drop policy if exists "autenticados veem execucoes" on checklist_execucoes;

create policy "admin ve execucoes"
  on checklist_execucoes for select
  to authenticated
  using (public.is_admin());


-- ----------------------------------------------------------------------------
-- [20260901120000_add_item_exige_foto.sql] (revisado em 20260903_item_anexos)
-- ----------------------------------------------------------------------------
-- Anexos de comprovação: por item da checklist, o admin define quantos arquivos
-- (foto, vídeo ou documento) são obrigatórios para concluir a tarefa.
--
--   - min_anexos -> config da tarefa (só admin altera, como titulo/responsavel);
--                   0 = opcional, N >= 1 = precisa de pelo menos N anexos.
--   - anexos     -> jsonb array de {url, tipo, nome}. O responsável pelo item
--                   adiciona/remove; o rollover diário limpa junto com o status.
--
-- A trava de conclusão é reforçada aqui no banco (trigger) além do client.

alter table checklist_items add column if not exists min_anexos int not null default 0;
alter table checklist_items add column if not exists anexos jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Trigger de update: agora também
--   1. trata min_anexos como campo só-admin;
--   2. deixa o responsável mexer em anexos (além do status);
--   3. barra status -> 'concluido' com menos anexos que min_anexos.
-- ---------------------------------------------------------------------------
create or replace function public.checklist_items_restrict_funcionario_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meu_nome text;
begin
  -- rollover diário (rollover_pendente) reinicia status/anexos em massa
  if coalesce(current_setting('app.bypass_item_guard', true), '') = 'on' then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.titulo is distinct from old.titulo
    or new.detalhe is distinct from old.detalhe
    or new.responsavel is distinct from old.responsavel
    or new.posicao is distinct from old.posicao
    or new.checklist_id is distinct from old.checklist_id
    or new.min_anexos is distinct from old.min_anexos
    or new.recorrencia is distinct from old.recorrencia
    or new.dias_semana is distinct from old.dias_semana
    or new.inicio is distinct from old.inicio
  then
    raise exception 'Apenas administradores podem editar os itens da checklist.';
  end if;

  if new.status is distinct from old.status or new.anexos is distinct from old.anexos then
    select nome into meu_nome from public.profiles where id = auth.uid();

    if meu_nome is null or lower(trim(meu_nome)) is distinct from lower(trim(old.responsavel)) then
      raise exception 'Você só pode marcar itens atribuídos a você.';
    end if;
  end if;

  if new.status = 'concluido'
    and new.status is distinct from old.status
    and coalesce(jsonb_array_length(new.anexos), 0) < new.min_anexos
  then
    raise exception 'Anexe pelo menos % arquivo(s) para concluir esta tarefa.', new.min_anexos;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rollover: limpar anexos junto com o status ao virar o dia, e guardar os
-- anexos no snapshot do dia fechado (checklist_execucoes.itens).
-- ---------------------------------------------------------------------------
create or replace function public.rollover_snapshot_dia(alvo date, usar_estado boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into checklist_execucoes
    (checklist_id, data, nome, setor, turno, horario, total_itens, itens_concluidos, completa, itens)
  select
    c.id,
    alvo,
    c.nome,
    c.setor,
    c.turno,
    c.horario,
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
          'responsavel', ci.responsavel,
          'status', case when usar_estado then ci.status else 'pendente' end,
          'min_anexos', ci.min_anexos,
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
  group by c.id
  on conflict (checklist_id, data) do nothing;
end;
$$;

create or replace function public.rollover_pendente()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tz constant text := 'America/Sao_Paulo';
  hoje_local date := (now() at time zone tz)::date;
  ultimo date;
  d date;
begin
  perform pg_advisory_xact_lock(hashtext('rollover_checklists'));

  select valor::date into ultimo from app_estado where chave = 'ultimo_rollover';

  if ultimo is null then
    insert into app_estado (chave, valor) values ('ultimo_rollover', hoje_local::text)
      on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
    return;
  end if;

  if ultimo >= hoje_local then
    return;
  end if;

  perform public.rollover_snapshot_dia(ultimo, true);
  d := ultimo + 1;
  while d < hoje_local loop
    perform public.rollover_snapshot_dia(d, false);
    d := d + 1;
  end loop;

  perform set_config('app.bypass_item_guard', 'on', true);
  update checklist_items
    set status = 'pendente', anexos = '[]'::jsonb
    where status <> 'pendente' or anexos <> '[]'::jsonb;

  update app_estado set valor = hoje_local::text, atualizado_em = now()
    where chave = 'ultimo_rollover';
end;
$$;


-- ----------------------------------------------------------------------------
-- [20260901121000_add_checklist_fotos_bucket.sql]
-- ----------------------------------------------------------------------------
-- Bucket das fotos de comprovação das tarefas (ver 20260901120000_add_item_exige_foto).
-- Público na leitura (a URL pública é guardada em checklist_items.foto_url e
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
