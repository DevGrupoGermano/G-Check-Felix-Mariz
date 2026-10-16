-- ============================================================================
-- G-check — bucket `checklist-fotos` aceita só imagens
-- ----------------------------------------------------------------------------
-- O envio de vídeo foi removido do app (estourava o storage do Supabase). Este
-- script fecha a porta também no Storage: qualquer upload que não seja imagem
-- (ex.: celular com o build antigo ainda aberto gravando vídeo) é recusado.
-- Fotos da câmera saem como JPEG ≤1600px, bem abaixo de 5MB.
-- Vídeos já enviados continuam lá até a limpeza de 7 dias (cleanup:anexos).
-- ============================================================================

update storage.buckets
set allowed_mime_types = array['image/*'],
    file_size_limit = 5 * 1024 * 1024
where id = 'checklist-fotos';
