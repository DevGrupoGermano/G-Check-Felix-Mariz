import { BUCKET_ANEXOS } from "@/lib/supabase";

const MARCADOR_URL_PUBLICA = `/object/public/${BUCKET_ANEXOS}/`;

/**
 * Extrai o caminho dentro do bucket a partir da URL pública salva no anexo
 * (`checklist_items.anexos` / `checklist_execucoes.itens[].anexos`). Continua
 * funcionando mesmo com o bucket privado — é só parsing de string, não
 * depende do arquivo estar acessível publicamente.
 */
export function caminhoDoAnexo(url: string): string | null {
  const idx = url.indexOf(MARCADOR_URL_PUBLICA);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + MARCADOR_URL_PUBLICA.length));
}
