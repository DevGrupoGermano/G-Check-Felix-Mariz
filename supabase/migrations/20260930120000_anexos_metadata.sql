-- ============================================================================
-- G-check — tabela de metadados dos anexos (id, checklist_item_id, storage_path,
-- mime_type, size_bytes, created_at, expires_at)
-- ----------------------------------------------------------------------------
-- Passo 1/2 da migração de armazenamento (ver plano). Este script é ADITIVO:
-- não mexe no bucket `checklist-fotos` (continua público) nem no formato do
-- jsonb `checklist_items.anexos` / `checklist_execucoes.itens[].anexos`
-- ({url, tipo, nome}) — zero mudança de comportamento visível pro app atual.
--
-- O `storage_path` é derivado da URL pública salva no jsonb (mesmo esquema já
-- usado por `caminhoDoAnexo`/`caminhoDaUrl` no código: tudo depois de
-- "/object/public/checklist-fotos/"). Isso continua funcionando mesmo depois
-- do bucket virar privado (passo 2, migration separada), porque é só parsing
-- de string, não depende do arquivo estar acessível.
-- ============================================================================

create table if not exists public.anexos (
  id uuid primary key default gen_random_uuid(),
  -- nullable: anexos históricos (já congelados em checklist_execucoes antes
  -- desta migration) nem sempre têm como resolver o item de origem com certeza.
  checklist_item_id text references public.checklist_items(id) on delete set null,
  storage_path text not null unique,
  mime_type text not null,
  nome_original text not null default '',
  size_bytes bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  constraint anexos_expira_depois_de_criar check (expires_at > created_at)
);

create index if not exists anexos_expires_at_idx on public.anexos (expires_at);
create index if not exists anexos_checklist_item_id_idx on public.anexos (checklist_item_id);

alter table public.anexos enable row level security;

-- Mesmo modelo de confiança que já existe hoje no bucket (qualquer autenticado
-- lê/escreve/apaga qualquer anexo — não é uma regressão de segurança, é o
-- comportamento atual só que agora expresso em RLS de tabela também).
drop policy if exists "autenticados leem anexos" on public.anexos;
create policy "autenticados leem anexos"
  on public.anexos for select
  to authenticated
  using (true);

drop policy if exists "autenticados inserem anexos" on public.anexos;
create policy "autenticados inserem anexos"
  on public.anexos for insert
  to authenticated
  with check (true);

drop policy if exists "autenticados removem anexos" on public.anexos;
create policy "autenticados removem anexos"
  on public.anexos for delete
  to authenticated
  using (true);

-- ----------------------------------------------------------------------------
-- Trigger de auto-registro: garante que TODO anexo novo em checklist_items
-- ganhe uma linha de metadados, mesmo que a escrita venha de uma aba com o
-- front antigo em cache (que ainda não sabe inserir em `anexos` diretamente)
-- durante a janela de transição. Se o código novo já inseriu a linha (com
-- size_bytes real) antes de gravar o jsonb, o `on conflict do nothing` evita
-- duplicar/sobrescrever.
--
-- IMPORTANTE: só REGISTRA elementos novos — nunca apaga. O rollover diário
-- (rollover_pendente) zera checklist_items.anexos para '[]' todo dia; isso não
-- é uma remoção de anexo, é só o item "esquecendo" a referência (o arquivo já
-- foi congelado em checklist_execucoes.itens[] no mesmo instante, pelo
-- rollover_snapshot_dia). A remoção de metadados só deve acontecer quando o
-- usuário remove o anexo explicitamente, ou pelo expurgo automático via
-- expires_at — nunca por causa do rollover.
-- ----------------------------------------------------------------------------
create or replace function public.registrar_anexos_novos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  marcador constant text := '/object/public/checklist-fotos/';
  elemento jsonb;
  idx int;
  caminho text;
begin
  for elemento in select * from jsonb_array_elements(coalesce(new.anexos, '[]'::jsonb))
  loop
    -- já existia no estado anterior do array: nada a fazer.
    if old.anexos is not null and old.anexos @> jsonb_build_array(elemento) then
      continue;
    end if;

    idx := position(marcador in coalesce(elemento->>'url', ''));
    if idx = 0 then
      continue; -- formato inesperado (sem URL pública reconhecível) — ignora
    end if;
    caminho := substring(elemento->>'url' from idx + length(marcador));
    if caminho is null or caminho = '' then
      continue;
    end if;

    insert into public.anexos (checklist_item_id, storage_path, mime_type, nome_original, expires_at)
    values (
      new.id,
      caminho,
      coalesce(nullif(elemento->>'tipo', ''), 'application/octet-stream'),
      coalesce(elemento->>'nome', ''),
      now() + interval '7 days'
    )
    on conflict (storage_path) do nothing;
  end loop;

  return new;
end;
$$;

drop trigger if exists anexos_registrar_novos on public.checklist_items;
create trigger anexos_registrar_novos
  after update of anexos on public.checklist_items
  for each row
  when (new.anexos is distinct from old.anexos)
  execute function public.registrar_anexos_novos();
