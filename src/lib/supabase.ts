import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env["VITE_SUPABASE_URL"];
const supabaseAnonKey = import.meta.env["VITE_SUPABASE_ANON_KEY"];

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY precisam estar definidas (arquivo .env).",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/** Bucket dos anexos de comprovação das tarefas (ver migration 20260901121000). */
export const BUCKET_ANEXOS = "checklist-fotos";

/** Um anexo de comprovação (foto, vídeo ou documento) de um item de checklist. */
export interface Anexo {
  /** URL pública "histórica" salva no jsonb — usada só para derivar o
   *  `storage_path` (ver `caminhoDoAnexo` em `@/lib/anexos-path`) e assinar uma
   *  URL temporária na hora de exibir; o bucket é privado, então essa URL não
   *  resolve mais sozinha. */
  url: string;
  /** MIME do arquivo (ex.: "image/jpeg", "video/mp4", "application/pdf"). */
  tipo: string;
  /** Nome original do arquivo, para exibição. */
  nome: string;
}

/** Linha da tabela `anexos` — metadados do arquivo (ver migration
 *  20260930120000_anexos_metadata.sql). Fonte de verdade para tamanho, mime e
 *  expiração; o array `Anexo[]` acima continua sendo o que o item referencia
 *  diretamente. */
export interface AnexoRow {
  id: string;
  checklist_item_id: string | null;
  storage_path: string;
  mime_type: string;
  nome_original: string;
  size_bytes: number | null;
  created_at: string;
  expires_at: string;
}

export interface ChecklistRow {
  id: string;
  nome: string;
  /** Funcionário responsável por toda a rotina (todos os itens dela). */
  responsavel: string;
  ativo: boolean;
  /** "HH:MM:SS" ou null — horário limite para concluir a rotina. */
  tempo_limite: string | null;
  /** Reabre os itens sozinha ao longo do dia (ex.: giro da Segurança a cada 20 min). */
  reabre_automatico: boolean;
  /** Intervalo em minutos entre as reaberturas — usado quando reabre_automatico. */
  reabre_intervalo_min: number | null;
  /** Datas "yyyy-MM-dd" em que a rotina está de folga (não roda, não cobra). */
  dias_pausados: string[];
  /** "HH:MM:SS" ou null — hora em que o "dia" desta rotina vira, para turnos que
   *  atravessam a meia-noite (ex.: 23:00-06:00). Null = vira à meia-noite (padrão). */
  corte_dia: string | null;
  /** Timestamptz de criação (default now()). Marca a partir de quando a rotina existe. */
  created_at: string;
}

/** Modo de recorrência de uma atividade (item). */
export type RecorrenciaRow = "semanal" | "quinzenal" | "mensal";

/** Tipo de uma atividade: marca simples ou enquete com opções de resposta. */
export type TipoTarefaRow = "checklist" | "enquete";

export interface ChecklistItemRow {
  id: string;
  checklist_id: string;
  titulo: string;
  detalhe: string | null;
  status: string;
  posicao: number;
  /** 'checklist' = marca feito/não feito; 'enquete' = escolhe uma opção. */
  tipo_tarefa: TipoTarefaRow;
  /** Opções da enquete (ex.: ["SIM","NÃO"]); vazio quando tipo_tarefa = 'checklist'. */
  resposta_opcoes: string[];
  /** Opção escolhida na execução; limpa no rollover. */
  resposta: string | null;
  /** Motivo/observação informado na execução; limpo no rollover. */
  justificativa: string | null;
  /** Turno da atividade (por item, não por rotina). */
  turno: string | null;
  /** "HH:MM:SS" — janela de execução da atividade. */
  horario_inicio: string | null;
  horario_termino: string | null;
  /** Quantos anexos são obrigatórios para concluir (0 = opcional). */
  min_anexos: number;
  /** Teto de anexos (null = sem limite). */
  max_anexos: number | null;
  /** Anexos enviados no dia; limpos no rollover. */
  anexos: Anexo[];
  /** Timestamptz de quando o item virou 'concluido' (carimbado por trigger no
   *  banco); null enquanto pendente ou depois de reaberto. */
  concluido_em: string | null;
  /** Modo de recorrência da atividade. */
  recorrencia: RecorrenciaRow;
  /** Dias da semana (0=domingo..6=sábado) — usado quando recorrencia = 'semanal'. */
  dias_semana: number[];
  /** Data de início "yyyy-MM-dd" — usado quando recorrencia = 'quinzenal'/'mensal'. */
  inicio: string | null;
}

export interface DiaDesativadoRow {
  /** ISO "yyyy-MM-dd" (tipo date do Postgres). */
  data: string;
  criado_por: string | null;
  created_at: string;
}

/** Snapshot de uma checklist num dia — gravado no rollover diário. */
export interface ChecklistExecucaoRow {
  id: string;
  checklist_id: string;
  /** ISO "yyyy-MM-dd". */
  data: string;
  nome: string;
  /** Sempre null desde 20260905 — turno/horário passaram para os itens. */
  turno: string | null;
  horario: string | null;
  total_itens: number;
  itens_concluidos: number;
  completa: boolean;
  itens: {
    titulo: string;
    responsavel: string;
    status: string;
    tipo_tarefa?: TipoTarefaRow;
    resposta_opcoes?: string[];
    resposta?: string | null;
    justificativa?: string | null;
    turno?: string | null;
    horario_inicio?: string | null;
    horario_termino?: string | null;
    min_anexos?: number;
    max_anexos?: number | null;
    anexos?: Anexo[];
    concluido_em?: string | null;
  }[];
  registrado_em: string;
}
