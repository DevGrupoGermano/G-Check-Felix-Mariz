import { limparAnexos } from "../src/lib/anexos-cleanup";

/**
 * Limpeza avulta/agendada dos anexos do bucket `checklist-fotos`.
 *
 * Uso local (lê `.env` automaticamente via Bun):
 *   bun run cleanup:anexos            # apaga de verdade
 *   bun run cleanup:anexos:dry        # só mostra o que seria apagado
 *
 * No GitHub Actions (.github/workflows/cleanup-anexos.yml) as mesmas
 * variáveis vêm de repository secrets em vez do `.env`.
 */
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
  const resultado = await limparAnexos({ supabaseUrl, serviceRoleKey, dryRun });

  console.log(
    `Expirados (anexos.expires_at): ${resultado.expirados} — ` +
      `${dryRun ? "seriam removidos" : "removidos"}: ${resultado.expiradosRemovidos} ` +
      `(${(resultado.bytesLiberadosExpirados / 1024 / 1024).toFixed(1)} MB)`,
  );
  console.log(
    `Órfãos no bucket sem metadados (fora do grace period): ${resultado.orfaosEncontrados} — ` +
      `${dryRun ? "seriam removidos" : "removidos"}: ${resultado.orfaosRemovidos}`,
  );

  if (resultado.erros.length > 0) {
    console.error("Erros durante a limpeza:");
    for (const erro of resultado.erros) console.error(`  - ${erro}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
