import { BUCKET_ANEXOS, supabase } from "@/lib/supabase";

const SIGNED_URL_TTL_PADRAO_S = 3600;

export interface ResultadoUpload {
  path: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Abstração fina sobre o Storage do Supabase — o resto do app fala só com
 * essa interface (upload/delete/getSignedUrl), sem chamar `supabase.storage`
 * direto. Trocar de provedor (ou de estratégia de acesso) fica restrito a
 * este arquivo.
 */
export interface StorageService {
  upload(path: string, arquivo: File, opts?: { upsert?: boolean }): Promise<ResultadoUpload>;
  delete(paths: string[]): Promise<void>;
  getSignedUrl(path: string, expiresInSegundos?: number): Promise<string>;
  /** Assina em lote — evita N requisições sequenciais ao renderizar uma lista de miniaturas. */
  getSignedUrls(paths: string[], expiresInSegundos?: number): Promise<Record<string, string>>;
  list(
    pasta: string,
    opts?: { limit?: number; offset?: number },
  ): ReturnType<ReturnType<typeof supabase.storage.from>["list"]>;
}

export function createStorageService(bucket: string): StorageService {
  const client = () => supabase.storage.from(bucket);

  return {
    async upload(path, arquivo, opts) {
      const { error } = await client().upload(path, arquivo, {
        upsert: opts?.upsert ?? true,
        ...(arquivo.type ? { contentType: arquivo.type } : {}),
      });
      if (error) throw error;
      return {
        path,
        mimeType: arquivo.type || "application/octet-stream",
        sizeBytes: arquivo.size,
      };
    },

    async delete(paths) {
      if (paths.length === 0) return;
      const { error } = await client().remove(paths);
      if (error) throw error;
    },

    async getSignedUrl(path, expiresInSegundos = SIGNED_URL_TTL_PADRAO_S) {
      const { data, error } = await client().createSignedUrl(path, expiresInSegundos);
      if (error) throw error;
      return data.signedUrl;
    },

    async getSignedUrls(paths, expiresInSegundos = SIGNED_URL_TTL_PADRAO_S) {
      if (paths.length === 0) return {};
      const { data, error } = await client().createSignedUrls(paths, expiresInSegundos);
      if (error) throw error;
      const mapa: Record<string, string> = {};
      for (const item of data ?? []) {
        if (item.signedUrl && item.path) mapa[item.path] = item.signedUrl;
      }
      return mapa;
    },

    list(pasta, opts) {
      return client().list(pasta, opts);
    },
  };
}

/** Instância padrão para o bucket de anexos de checklist. */
export const anexosStorageService = createStorageService(BUCKET_ANEXOS);
