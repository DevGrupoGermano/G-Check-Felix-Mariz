-- ============================================================================
-- G-check — remoção do cadastro de Setores
-- ----------------------------------------------------------------------------
-- No Supermercado Félix, funcionário e setor sempre foram a mesma coisa na
-- prática: cada rotina tem um único responsável, e o "setor" dela sempre foi
-- o mesmo texto do responsável (ver comentário de
-- 20260905130000_seed_checklists_felix.sql, linha 12-14). Isso obrigava a
-- cadastrar a mesma informação duas vezes — uma em Funcionários, outra em
-- Setores. Setores deixa de existir como cadastro; checklists.responsavel
-- (ver 20260908120000_responsavel_por_rotina.sql) passa a ser a única
-- referência.
--
-- Remove:
--   - a tabela setores (e suas policies, via cascade);
--   - checklists.setor;
--   - checklist_execucoes.setor (histórico: quem precisar do responsável de um
--     dia já fechado acha em itens[0].responsavel, que já é gravado desde a
--     migration anterior).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- rollover_snapshot_dia: para de selecionar/gravar checklists.setor.
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
  group by c.id
  on conflict (checklist_id, data) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- notificar_rotinas / notificar_email_html: o e-mail mostrava o setor da
-- rotina; passa a mostrar o responsável. Postgres não deixa renomear
-- parâmetro com CREATE OR REPLACE — precisa apagar a função antes.
-- ---------------------------------------------------------------------------
drop function if exists public.notificar_email_html(
  text, text, text, text, text, text, text, text[], text, text, text, text
);

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
-- Remove o cadastro de setores e as colunas redundantes.
-- ---------------------------------------------------------------------------
drop table if exists setores cascade;

alter table checklists drop column if exists setor;
alter table checklist_execucoes drop column if exists setor;
