-- ============================================================================
-- G-check — notificação por e-mail: rotina concluída / rotina atrasada
-- ----------------------------------------------------------------------------
-- Mesmo padrão de reabertura automática (20260905140000): uma função
-- security definer, disparada por pg_cron a cada 5 min e, como rede de
-- segurança, pelo client (GCheckProvider) no mesmo intervalo.
--
-- "Concluída"/"atrasada" usam exatamente a mesma regra da tela
-- (src/lib/g-check-store.tsx: estado()/limiteDaRotina()):
--   - total/feitos = itens da rotina cuja recorrência cai em hoje
--     (public.item_roda_no_dia);
--   - limite = tempo_limite manual, ou o maior horario_termino cadastrado
--     entre os itens da rotina;
--   - concluída  = total > 0 e feitos = total;
--   - atrasada   = não concluída, tem limite, e o horário atual já passou dele.
-- Rotina sem nenhum item hoje não entra na checagem.
--
-- checklist_notificacoes evita reenviar o mesmo e-mail no mesmo dia (1 por
-- rotina/dia/tipo) — tabela interna, sem policy (só a função, via security
-- definer, mexe nela), mesmo padrão de app_estado.
--
-- E-mail via Resend (https://resend.com/docs/api-reference/emails/send-email),
-- chamado com pg_net a partir do Postgres — sem Edge Function. Credenciais
-- (API key e remetente) ficam no Vault, não em texto puro na migration:
--
--   select vault.update_secret(id, 'sua-api-key-da-resend')
--     from vault.secrets where name = 'resend_api_key';
--   select vault.update_secret(id, 'G-Check <notificacoes@seudominio.com.br>')
--     from vault.secrets where name = 'resend_from_email';
--
-- Enquanto resend_api_key ficar no valor placeholder, notificar_rotinas()
-- não faz nada (return antecipado) — seguro rodar esta migration antes de
-- configurar a conta na Resend.
-- ============================================================================

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

-- http (pgsql-http): chamada SÍNCRONA à Resend, pra só marcar como enviado
-- quando a resposta vier 2xx de verdade (ver resend_enviar() mais abaixo).
-- Sem isso teríamos que usar pg_net "solto" (assíncrono) e nunca saber se a
-- Resend aceitou — na prática, uma falha (ex: domínio ainda não verificado)
-- ficaria marcada como "enviada" e nunca mais tentaria de novo.
do $$
begin
  execute 'create extension if not exists http with schema extensions';
exception when others then
  raise notice 'extensao http indisponivel (%). resend_enviar() vai cair no modo best-effort via pg_net.', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- Segredos (placeholder até você configurar de verdade — ver instruções acima).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Controle de envio (1 e-mail por rotina/dia/tipo).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Template do e-mail: identidade da marca Félix — cabeçalho vermelho/amarelo
-- com a logo no meio (mesmas cores de src/routes/login.tsx: COR_FUNDO
-- #FFDA24, COR_FORM #BF2020), título com nome/status/data, texto explicativo,
-- contagem, lista de atividades atrasadas (só quando houver), botão pro
-- sistema e rodapé com contato de suporte + logo G-Tech. CSS inline (padrão
-- pra e-mail: cliente de e-mail não confia em <style>/classe).
-- ---------------------------------------------------------------------------
create or replace function public.notificar_email_html(
  p_status text,          -- 'ATRASADA' ou 'CONCLUÍDA' (etiqueta acima do título)
  p_nome text,             -- nome da rotina
  p_setor text,
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

    -- Cabeçalho: |----vermelho----|amarelo + logo Félix Matriz|----vermelho----|
    '<tr><td style="padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' ||
    '<td width="20%" style="background-color:#BF2020;height:72px;font-size:0;line-height:0;">&nbsp;</td>' ||
    '<td width="60%" style="background-color:#FFDA24;text-align:center;padding:10px 0;">' ||
    format('<img src="%s" width="90" alt="Felix Matriz" style="display:inline-block;">', p_logo_felix) ||
    '</td>' ||
    '<td width="20%" style="background-color:#BF2020;height:72px;font-size:0;line-height:0;">&nbsp;</td>' ||
    '</tr></table></td></tr>' ||

    -- Título: nome da rotina, status, setor, data/hora
    format(
      '<tr><td style="padding:28px 28px 0;">' ||
      '<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.06em;' ||
      'text-transform:uppercase;color:#BF2020;">%s</p>' ||
      '<h1 style="margin:0 0 4px;font-size:21px;line-height:1.3;color:#1A1A1A;">%s</h1>' ||
      '<p style="margin:0;font-size:13px;color:#767676;">%s &middot; %s &agrave;s %s</p>' ||
      '</td></tr>',
      p_status, p_nome, p_setor, p_data, p_hora
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

-- ---------------------------------------------------------------------------
-- Envio: chamada síncrona à Resend via extensão http — só retorna true (e só
-- aí notificar_rotinas() marca como enviado) quando a Resend responde 2xx de
-- verdade. Se a extensão http não estiver disponível por algum motivo, cai
-- pro pg_net "solto" (best-effort, mesmo risco de antes) em vez de travar o
-- job inteiro — assim uma rotina não deixa de notificar as outras.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Checagem + envio.
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
      ch.setor,
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
    group by ch.id, ch.nome, ch.setor, ch.tempo_limite
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
          'CONCLUÍDA', c.nome, c.setor, data_fmt, hora_fmt,
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
          'ATRASADA', c.nome, c.setor, data_fmt, hora_fmt,
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
-- Agendamento (pg_cron) — best effort, mesmo padrão das outras rotinas internas.
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'create extension if not exists pg_cron';
  perform cron.schedule(
    'notificar-rotinas-email',
    '*/5 * * * *',
    'select public.notificar_rotinas()'
  );
exception when others then
  raise notice 'pg_cron nao configurado (%). Notificacao via fallback do client.', sqlerrm;
end;
$$;
