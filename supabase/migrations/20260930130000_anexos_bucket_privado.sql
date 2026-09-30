-- ============================================================================
-- G-check — bucket `checklist-fotos` privado (passo 2/2 da migração de storage)
-- ----------------------------------------------------------------------------
-- NÃO RODAR ESTE ARQUIVO ainda. Só aplique depois de confirmar que o app novo
-- (o que resolve signed URL a partir de `a.url` via StorageService, em vez de
-- usar a URL pública direto) já está no ar e funcionando — qualquer aba com o
-- build antigo aberta vai parar de conseguir exibir miniaturas assim que este
-- script rodar (o upload/remoção continuam funcionando normalmente, só a URL
-- pública salva antiga para de resolver).
-- ============================================================================

update storage.buckets set public = false where id = 'checklist-fotos';

drop policy if exists "checklist-fotos leitura publica" on storage.objects;
drop policy if exists "checklist-fotos leitura autenticada" on storage.objects;
create policy "checklist-fotos leitura autenticada"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'checklist-fotos');
