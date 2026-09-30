import { createClient } from "@supabase/supabase-js";

/**
 * Limpeza de anexos expirados/órfãos no bucket `checklist-fotos`.
 *
 * Roda fora do app (script local + workflow do GitHub Actions), por isso cria
 * seu próprio client em vez de importar `@/lib/supabase` (que depende de
 * `import.meta.env`, só populado dentro do Vite).
 *
 * A partir da migration 20260930120000_anexos_metadata.sql, a retenção é
 * dirigida por `anexos.expires_at` (setado no upload, ~7 dias) em vez de
 * recomputar o "conjunto válido" cruzando os jsonb de checklist_items /
 * checklist_execucoes toda vez — mais barato e não depende de re-listar o
 * histórico inteiro. Mantemos uma varredura de segurança pra órfãos
 * verdadeiros (arquivo no bucket sem linha em `anexos` — upload feito fora do
 * app, ou uma falha pontual do trigger `anexos_registrar_novos`), com um
 * grace period pra não pegar um upload em andamento.
 */
const BUCKET_ANEXOS = "checklist-fotos";
const GRACE_PERIOD_ORFAO_MS = 60 * 60 * 1000; // 1h

export interface ResultadoLimpezaAnexos {
  expirados: number;
  expiradosRemovidos: number;
  bytesLiberadosExpirados: number;
  orfaosEncontrados: number;
  orfaosRemovidos: number;
  erros: string[];
}

function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

export async function limparAnexos(opts: {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Só lista o que seria removido, sem apagar de verdade. */
  dryRun?: boolean;
}): Promise<ResultadoLimpezaAnexos> {
  const supabase = createClient(opts.supabaseUrl, opts.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const erros: string[] = [];

  // ---------------------------------------------------------------------
  // 1) Expirados — dirigido por anexos.expires_at.
  // ---------------------------------------------------------------------
  const { data: expiradosRows, error: expiradosError } = await supabase
    .from("anexos")
    .select("id, storage_path, size_bytes")
    .lt("expires_at", new Date().toISOString());
  if (expiradosError) throw new Error(`Falha ao consultar anexos expirados: ${expiradosError.message}`);

  const expirados = expiradosRows ?? [];
  const bytesLiberadosExpirados = expirados.reduce((soma, a) => soma + (a.size_bytes ?? 0), 0);

  let expiradosRemovidos = 0;
  if (!opts.dryRun) {
    for (const lote of emLotes(expirados, 100)) {
      const caminhos = lote.map((a) => a.storage_path);
      const { error: removeError } = await supabase.storage.from(BUCKET_ANEXOS).remove(caminhos);
      if (removeError) {
        erros.push(`Falha ao remover lote de ${caminhos.length} arquivo(s) expirado(s): ${removeError.message}`);
        continue;
      }
      const { error: deleteError } = await supabase
        .from("anexos")
        .delete()
        .in(
          "id",
          lote.map((a) => a.id),
        );
      if (deleteError) {
        erros.push(`Falha ao apagar metadados de ${lote.length} anexo(s): ${deleteError.message}`);
        continue;
      }
      expiradosRemovidos += lote.length;
    }
  } else {
    expiradosRemovidos = expirados.length;
  }

  // ---------------------------------------------------------------------
  // 2) Varredura de segurança — objetos no bucket sem linha em `anexos`,
  //    fora do grace period (pra não pegar upload em andamento).
  // ---------------------------------------------------------------------
  const caminhosConhecidos = new Set<string>();
  {
    const tamanhoPagina = 1000;
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("anexos")
        .select("storage_path")
        .range(offset, offset + tamanhoPagina - 1);
      if (error) throw new Error(`Falha ao listar storage_path conhecidos: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const row of data) caminhosConhecidos.add(row.storage_path);
      if (data.length < tamanhoPagina) break;
      offset += tamanhoPagina;
    }
  }

  const orfaos: string[] = [];
  const corteGrace = Date.now() - GRACE_PERIOD_ORFAO_MS;
  {
    const { data: pastas, error: pastasError } = await supabase.storage
      .from(BUCKET_ANEXOS)
      .list("", { limit: 1000 });
    if (pastasError) throw new Error(`Falha ao listar bucket: ${pastasError.message}`);

    for (const pasta of pastas ?? []) {
      if (pasta.id !== null) continue;
      let offset = 0;
      const limite = 1000;
      for (;;) {
        const { data: arquivos, error: listaError } = await supabase.storage
          .from(BUCKET_ANEXOS)
          .list(pasta.name, { limit: limite, offset });
        if (listaError) {
          erros.push(`Falha ao listar pasta "${pasta.name}": ${listaError.message}`);
          break;
        }
        if (!arquivos || arquivos.length === 0) break;
        for (const arquivo of arquivos) {
          if (arquivo.id === null) continue;
          const caminho = `${pasta.name}/${arquivo.name}`;
          if (caminhosConhecidos.has(caminho)) continue;
          const criadoEm = arquivo.created_at ? new Date(arquivo.created_at).getTime() : 0;
          if (criadoEm > corteGrace) continue; // pode ser upload em andamento — espera o próximo ciclo
          orfaos.push(caminho);
        }
        if (arquivos.length < limite) break;
        offset += limite;
      }
    }
  }

  let orfaosRemovidos = 0;
  if (opts.dryRun) {
    orfaosRemovidos = orfaos.length;
  } else {
    for (const lote of emLotes(orfaos, 100)) {
      const { error } = await supabase.storage.from(BUCKET_ANEXOS).remove(lote);
      if (error) {
        erros.push(`Falha ao remover lote de ${lote.length} órfão(s): ${error.message}`);
        continue;
      }
      orfaosRemovidos += lote.length;
    }
  }

  return {
    expirados: expirados.length,
    expiradosRemovidos,
    bytesLiberadosExpirados,
    orfaosEncontrados: orfaos.length,
    orfaosRemovidos,
    erros,
  };
}
