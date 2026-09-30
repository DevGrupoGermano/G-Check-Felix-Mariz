import { createClient } from "@supabase/supabase-js";

const BUCKET_ANEXOS = "checklist-fotos";
const MARCADOR_URL_PUBLICA = `/object/public/${BUCKET_ANEXOS}/`;
const RETENCAO_DIAS = 7;

/**
 * Preenche a tabela `anexos` (migration 20260930120000_anexos_metadata.sql)
 * para o acervo que já existia ANTES da migration — o trigger
 * `anexos_registrar_novos` só cobre escritas a partir de quando ele foi
 * criado, então isso é um passo único.
 *
 * Não toca em `checklist_items`/`checklist_execucoes` — só lê. Roda fora do
 * app (mesmo padrão de scripts/cleanup-anexos.ts), por isso cria seu próprio
 * client em vez de importar `@/lib/supabase`.
 *
 * Uso local (lê `.env` automaticamente via Bun):
 *   bun run scripts/backfill-anexos-metadata.ts --dry-run
 *   bun run scripts/backfill-anexos-metadata.ts
 */

interface AnexoMinimo {
  url: string;
  tipo?: string;
  nome?: string;
}

function caminhoDaUrl(url: string): string | null {
  const idx = url.indexOf(MARCADOR_URL_PUBLICA);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + MARCADOR_URL_PUBLICA.length));
}

async function main() {
  const supabaseUrl = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "Defina SUPABASE_URL (ou VITE_SUPABASE_URL) e SUPABASE_SERVICE_ROLE_KEY antes de rodar.",
    );
    process.exit(1);
  }
  const dryRun = process.argv.includes("--dry-run");
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Objetos reais do bucket — fonte de verdade pra size/mime/created_at.
  const objetos = new Map<
    string,
    { size: number | null; mimetype: string | null; createdAt: string | null }
  >();
  {
    const { data: pastas, error } = await supabase.storage.from(BUCKET_ANEXOS).list("", {
      limit: 1000,
    });
    if (error) throw new Error(`Falha ao listar bucket: ${error.message}`);
    for (const pasta of pastas ?? []) {
      if (pasta.id !== null) continue;
      let offset = 0;
      const limite = 1000;
      for (;;) {
        const { data: arquivos, error: listaError } = await supabase.storage
          .from(BUCKET_ANEXOS)
          .list(pasta.name, { limit: limite, offset });
        if (listaError) {
          console.error(`Falha ao listar pasta "${pasta.name}": ${listaError.message}`);
          break;
        }
        if (!arquivos || arquivos.length === 0) break;
        for (const arquivo of arquivos) {
          if (arquivo.id === null) continue;
          const caminho = `${pasta.name}/${arquivo.name}`;
          objetos.set(caminho, {
            size: Number(arquivo.metadata?.["size"] ?? 0) || null,
            mimetype: String(arquivo.metadata?.["mimetype"] ?? "") || null,
            createdAt: arquivo.created_at ?? null,
          });
        }
        if (arquivos.length < limite) break;
        offset += limite;
      }
    }
  }

  // 2) checklist_item_id resolvido a partir dos anexos "vivos" de hoje.
  const itemIdPorCaminho = new Map<string, string>();
  {
    const { data, error } = await supabase.from("checklist_items").select("id, anexos");
    if (error) throw new Error(`Falha ao ler checklist_items: ${error.message}`);
    for (const row of data ?? []) {
      const r = row as { id: string; anexos: AnexoMinimo[] | null };
      for (const anexo of r.anexos ?? []) {
        const caminho = caminhoDaUrl(anexo.url);
        if (caminho) itemIdPorCaminho.set(caminho, r.id);
      }
    }
  }

  // 3) Anexos válidos (dentro da retenção) vindos do histórico congelado —
  //    sem item id resolvível com certeza (o snapshot não guarda o id).
  const validosSemItem = new Map<string, AnexoMinimo>();
  {
    const corteISO = new Date(Date.now() - RETENCAO_DIAS * 86_400_000).toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("checklist_execucoes")
      .select("itens")
      .gte("data", corteISO);
    if (error) throw new Error(`Falha ao ler checklist_execucoes: ${error.message}`);
    for (const row of data ?? []) {
      const itens = (row as { itens: { anexos?: AnexoMinimo[] }[] | null }).itens ?? [];
      for (const item of itens) {
        for (const anexo of item.anexos ?? []) {
          const caminho = caminhoDaUrl(anexo.url);
          if (caminho && !itemIdPorCaminho.has(caminho)) validosSemItem.set(caminho, anexo);
        }
      }
    }
  }

  // 4) Monta as linhas a inserir: só para objetos que existem de verdade no
  //    bucket E estão referenciados em algum lugar (vivo ou histórico recente).
  const linhas: {
    checklist_item_id: string | null;
    storage_path: string;
    mime_type: string;
    nome_original: string;
    size_bytes: number | null;
    created_at?: string;
    expires_at?: string;
  }[] = [];

  for (const [caminho, meta] of objetos) {
    const itemId = itemIdPorCaminho.get(caminho) ?? null;
    const anexoHistorico = validosSemItem.get(caminho);
    if (!itemId && !anexoHistorico) continue; // órfão — não referenciado em lugar nenhum, deixa pro cleanup

    const createdAt = meta.createdAt ?? new Date().toISOString();
    const expiresAt = new Date(
      new Date(createdAt).getTime() + RETENCAO_DIAS * 86_400_000,
    ).toISOString();

    linhas.push({
      checklist_item_id: itemId,
      storage_path: caminho,
      mime_type: meta.mimetype || anexoHistorico?.tipo || "application/octet-stream",
      nome_original: anexoHistorico?.nome ?? "",
      size_bytes: meta.size,
      created_at: createdAt,
      expires_at: expiresAt,
    });
  }

  console.log(`Objetos no bucket: ${objetos.size}`);
  console.log(`Referenciados (vivos ou histórico recente): ${linhas.length}`);
  console.log(`Órfãos (ignorados, ficam pro cleanup): ${objetos.size - linhas.length}`);

  if (dryRun) {
    console.log("\n(dry-run — nada foi inserido)");
    return;
  }

  const tamanhoLote = 200;
  let inseridos = 0;
  for (let i = 0; i < linhas.length; i += tamanhoLote) {
    const lote = linhas.slice(i, i + tamanhoLote);
    const { error, count } = await supabase
      .from("anexos")
      .upsert(lote, { onConflict: "storage_path", ignoreDuplicates: true, count: "exact" });
    if (error) {
      console.error(`Falha ao inserir lote de ${lote.length}: ${error.message}`);
      continue;
    }
    inseridos += count ?? lote.length;
  }
  console.log(`Linhas inseridas/atualizadas: ${inseridos}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
