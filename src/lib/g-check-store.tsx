import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BUCKET_ANEXOS,
  supabase,
  type Anexo,
  type ChecklistItemRow,
  type ChecklistRow,
} from "@/lib/supabase";
import { caminhoDoAnexo } from "@/lib/anexos-path";
import { anexosStorageService } from "@/lib/storage-service";
import { dataDoIso, isoDoDia, paraFusoLoja } from "@/lib/utils";
import { itemRodaNoDia, recorrencias, type Recorrencia } from "@/lib/recorrencia";
import { useAuth } from "@/lib/auth-store";
import {
  HISTORICO_QUERY_KEY,
  notificarRotinas,
  reabrirAutomaticas,
  rolloverPendente,
} from "@/lib/historico";

export { itemRodaNoDia, recorrencias, type Recorrencia };

export type ItemStatus = "pendente" | "concluido";

export const turnos = ["Manhã", "Tarde", "Noite"] as const;
export type Turno = (typeof turnos)[number];

const ORDEM_TURNO: Record<string, number> = { Manhã: 0, Tarde: 1, Noite: 2 };

/**
 * Turno de uma atividade a partir do horário de início "HH:MM":
 * 04:00–10:59 → Manhã · 11:00–17:59 → Tarde · 18:00–03:59 → Noite.
 */
export function turnoDoHorario(hhmm: string | null | undefined): Turno | null {
  if (!hhmm) return null;
  const h = Number(hhmm.slice(0, 2));
  if (Number.isNaN(h)) return null;
  if (h >= 4 && h < 11) return "Manhã";
  if (h >= 11 && h < 18) return "Tarde";
  return "Noite";
}

/** Tipos de atividade: marca simples ou enquete com opções de resposta. */
export const tiposTarefa = ["checklist", "enquete"] as const;
export type TipoTarefa = (typeof tiposTarefa)[number];

/**
 * Dias da semana em que a rotina roda. O valor é o índice JS de Date.getDay()
 * (0 = domingo … 6 = sábado); "inicial" é o rótulo do botão no formulário,
 * na ordem D S T Q Q S S.
 */
export const diasDaSemana = [
  { valor: 0, inicial: "D", nome: "Domingo" },
  { valor: 1, inicial: "S", nome: "Segunda" },
  { valor: 2, inicial: "T", nome: "Terça" },
  { valor: 3, inicial: "Q", nome: "Quarta" },
  { valor: 4, inicial: "Q", nome: "Quinta" },
  { valor: 5, inicial: "S", nome: "Sexta" },
  { valor: 6, inicial: "S", nome: "Sábado" },
] as const;

export const todosOsDias = diasDaSemana.map((d) => d.valor);

/** Rótulo curto dos dias agendados para exibir nas cards. */
export function labelDiasSemana(dias: number[]): string {
  const ordenados = [...dias].sort((a, b) => a - b);
  if (ordenados.length === 0) return "Nenhum dia";
  if (ordenados.length === 7) return "Todos os dias";
  if (ordenados.join(",") === "1,2,3,4,5") return "Seg a sex";
  return ordenados.map((v) => diasDaSemana[v]?.inicial ?? "?").join(" · ");
}

const fmtDataCurta = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });

/** Rótulo da recorrência de uma atividade para exibir nas cards. */
export function labelRecorrencia(
  item: Pick<ChecklistItem, "recorrencia" | "diasSemana" | "inicio">,
): string {
  if (item.recorrencia === "semanal") return labelDiasSemana(item.diasSemana);
  if (!item.inicio) return item.recorrencia === "quinzenal" ? "Quinzenal" : "Mensal";
  const d = dataDoIso(item.inicio);
  return item.recorrencia === "quinzenal"
    ? `Quinzenal · desde ${fmtDataCurta.format(d)}`
    : `Mensal · dia ${d.getDate()}`;
}

export interface ChecklistItem {
  id: string;
  titulo: string;
  detalhe?: string;
  status: ItemStatus;
  /** 'checklist' = marca feito/não feito; 'enquete' = escolhe uma opção + justifica. */
  tipoTarefa: TipoTarefa;
  /** Opções da enquete (ex.: ["SIM","NÃO"]); vazio quando tipoTarefa = "checklist". */
  respostaOpcoes: string[];
  /** Opção escolhida hoje; limpa no rollover diário. */
  resposta: string | null;
  /** Motivo/observação informado hoje; limpo no rollover diário. */
  justificativa: string | null;
  /** Turno da atividade (por item). Deriva de `horarioInicio` quando ausente. */
  turno: string | null;
  /** "HH:MM" — janela de execução da atividade. */
  horarioInicio: string | null;
  horarioTermino: string | null;
  /** Quantos anexos são obrigatórios para concluir a tarefa (0 = opcional). */
  minAnexos: number;
  /** Teto de anexos (null = sem limite; não deixa passar). */
  maxAnexos: number | null;
  /** Anexos enviados hoje (foto, vídeo ou documento); limpos no rollover diário. */
  anexos: Anexo[];
  /** Quando o item virou "concluido" (carimbado pelo banco); null se pendente
   *  ou reaberto. Usada só pra saber se a conclusão veio depois do prazo —
   *  ver `situacaoItem`. */
  concluidoEm: string | null;
  /** Modo de recorrência da atividade. */
  recorrencia: Recorrencia;
  /** Índices de Date.getDay() (0 = domingo) — usados quando recorrencia = "semanal". */
  diasSemana: number[];
  /** Data de início "yyyy-MM-dd" — usada quando recorrencia = "quinzenal"/"mensal". */
  inicio: string | null;
}

export interface Checklist {
  id: string;
  nome: string;
  /** Funcionário responsável por toda a rotina (por todos os itens dela). */
  responsavel: string;
  ativo: boolean;
  /** Reabre os itens sozinha ao longo do dia (giro da Segurança etc.). */
  reabreAutomatico: boolean;
  /** Minutos entre as reaberturas — só usado quando reabreAutomatico. */
  reabreIntervaloMin?: number;
  /** Turnos que a rotina cobre — derivado dos itens, não gravado. */
  turnos: string[];
  /** Faixa de horário derivada dos itens ("HH:MM"), só para descrição. */
  horarioInicio?: string;
  horarioTermino?: string;
  /** "HH:MM" — horário limite para concluir; passou dele e não terminou = "atrasada". */
  tempoLimite?: string;
  /** "HH:MM" — hora em que o "dia" desta rotina vira, para turnos que atravessam a
   *  meia-noite (ex.: 23:00-06:00). Ausente = vira à meia-noite (padrão). Ver
   *  `diaOperacionalChecklist`. */
  corteDia?: string;
  /** Data de criação da rotina ("yyyy-MM-dd"). Antes disso ela não existia — o
   *  calendário/histórico não devem projetá-la para dias anteriores. */
  criadoEm: string;
  /** Datas "yyyy-MM-dd" em que a rotina está de folga (dia de folga do
   *  responsável, por exemplo) — não roda, não cobra, não notifica. */
  diasPausados: string[];
  itens: ChecklistItem[];
}

export interface ItemInput {
  /** Presente apenas ao editar um item já existente; identifica o item a preservar (status incluso). */
  id?: string;
  titulo: string;
  detalhe?: string;
  tipoTarefa: TipoTarefa;
  respostaOpcoes: string[];
  turno: string | null;
  horarioInicio: string | null;
  horarioTermino: string | null;
  /** Quantos anexos são obrigatórios para concluir a tarefa (0 = opcional). */
  minAnexos: number;
  /** Teto de anexos (null = sem limite). */
  maxAnexos: number | null;
  recorrencia: Recorrencia;
  diasSemana: number[];
  inicio: string | null;
}

export interface ChecklistInput {
  nome: string;
  /** Funcionário responsável por toda a rotina (por todos os itens dela). */
  responsavel: string;
  ativo: boolean;
  /** "HH:MM" ou undefined. */
  tempoLimite?: string;
  /** "HH:MM" ou undefined — ver `Checklist.corteDia`. */
  corteDia?: string;
  reabreAutomatico: boolean;
  reabreIntervaloMin?: number;
  /** Datas "yyyy-MM-dd" em que a rotina está de folga. */
  diasPausados: string[];
  itens: ItemInput[];
}

/** Minutos desde a meia-noite de um "HH:MM". */
function hhmmParaMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Turnos cobertos + faixa de horário (início–término) de uma rotina, derivados
 * dos itens. Ordenar os "HH:MM" em texto (menor início, maior término) só
 * funciona pra rotina que não passa da meia-noite — numa rotina que atravessa
 * a virada (ex.: "SUB Gerente Noturno", 20:00 até 07:30 do dia seguinte) isso
 * pegaria "00:30" (item já da madrugada) como início e algum horário da noite
 * anterior como término, invertido.
 *
 * Com `corteDia` (mesmo horário de corte da rotina — ver `Checklist.corteDia`
 * e a migration 20260921120000), os horários viram dois grupos: os que caem
 * antes do corte são madrugada — cauda do turno que começou no dia anterior,
 * contam pro TÉRMINO; os que caem no corte ou depois são o INÍCIO do turno.
 * Sem `corteDia`, mantém o cálculo simples de sempre.
 */
export function descricaoAgenda(
  itens: Pick<ChecklistItem, "turno" | "horarioInicio" | "horarioTermino">[],
  corteDia?: string,
) {
  const inicios = itens.map((i) => i.horarioInicio).filter((v): v is string => !!v);
  const terminos = itens.map((i) => i.horarioTermino).filter((v): v is string => !!v);

  let horarioInicio: string | undefined;
  let horarioTermino: string | undefined;

  if (corteDia) {
    const corteMin = hhmmParaMinutos(corteDia);
    const iniciosNoite = inicios.filter((h) => hhmmParaMinutos(h) >= corteMin).sort();
    const terminosMadrugada = terminos.filter((h) => hhmmParaMinutos(h) < corteMin).sort();
    // Sem nenhum horário no grupo esperado (rotina com corteDia mas sem
    // atividade de fato atravessando a madrugada) cai de volta no cálculo simples.
    horarioInicio = iniciosNoite[0] ?? [...inicios].sort()[0];
    horarioTermino = terminosMadrugada.length
      ? terminosMadrugada[terminosMadrugada.length - 1]
      : [...terminos].sort()[terminos.length - 1];
  } else {
    horarioInicio = [...inicios].sort()[0];
    horarioTermino = [...terminos].sort()[terminos.length - 1];
  }

  const turnosSet = new Set<string>();
  for (const i of itens) {
    const t = i.turno ?? turnoDoHorario(i.horarioInicio);
    if (t) turnosSet.add(t);
  }
  const turnosOrd = [...turnosSet].sort((a, b) => (ORDEM_TURNO[a] ?? 9) - (ORDEM_TURNO[b] ?? 9));
  return {
    turnos: turnosOrd,
    ...(horarioInicio ? { horarioInicio } : {}),
    ...(horarioTermino ? { horarioTermino } : {}),
  };
}

/** Gera um id legível a partir do nome (usado como PK da checklist no Supabase). */
function slugify(texto: string) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Ordena os itens do formulário por horário de início antes de gravar
 * `posicao` — o formulário só permite acrescentar item ao final da lista
 * (sem reordenar manualmente), então sem isso uma atividade nova entraria
 * sempre por último, fora do lugar cronológico. Item sem horário vai para o
 * fim; itens no mesmo horário mantêm a ordem relativa em que foram digitados.
 *
 * Com `corteDia` (rotina que atravessa a meia-noite), ordena pelo ciclo do
 * corte (ver `minutosNoCiclo`) em vez do horário cru — senão um item de
 * madrugada (ex.: 00:30) apareceria antes do início do turno à noite (ex.:
 * 23:00), que é quando a rotina realmente começa.
 */
function ordenarPorHorario(itens: ItemInput[], corteDia?: string): ItemInput[] {
  return itens
    .map((it, index) => ({ it, index }))
    .sort((a, b) => {
      const ma = a.it.horarioInicio ? minutosNoCiclo(a.it.horarioInicio, corteDia) : Infinity;
      const mb = b.it.horarioInicio ? minutosNoCiclo(b.it.horarioInicio, corteDia) : Infinity;
      return ma === mb ? a.index - b.index : ma - mb;
    })
    .map(({ it }) => it);
}

/** Campos de um item no formato do banco, comuns a criação e edição. */
function camposItemBanco(it: ItemInput) {
  const enquete = it.tipoTarefa === "enquete";
  return {
    titulo: it.titulo,
    detalhe: it.detalhe?.trim() || null,
    tipo_tarefa: it.tipoTarefa,
    resposta_opcoes: enquete ? it.respostaOpcoes : [],
    turno: it.turno ?? turnoDoHorario(it.horarioInicio),
    horario_inicio: it.horarioInicio || null,
    horario_termino: it.horarioTermino || null,
    min_anexos: it.minAnexos,
    max_anexos: it.maxAnexos,
    recorrencia: it.recorrencia,
    dias_semana: it.recorrencia === "semanal" ? it.diasSemana : [],
    inicio: it.recorrencia === "semanal" ? null : it.inicio,
  };
}

const QUERY_KEY = ["checklists"] as const;

/** Apaga da tabela de metadados as linhas correspondentes a uma lista de
 *  caminhos — best effort, mesmo espírito das funções abaixo. */
async function removerMetadadosDosAnexos(caminhos: string[]): Promise<void> {
  if (caminhos.length === 0) return;
  const { error } = await supabase.from("anexos").delete().in("storage_path", caminhos);
  if (error) console.error("Falha ao remover metadados de anexo(s):", error.message);
}

/** Apaga os arquivos do Storage (+ metadados) correspondentes a uma lista de
 *  anexos — best effort: erro aqui não deve travar a operação no banco (o
 *  cron de limpeza cobre qualquer órfão que sobrar). */
async function removerArquivosDosAnexos(anexos: { url: string }[]): Promise<void> {
  const caminhos = anexos.map((a) => caminhoDoAnexo(a.url)).filter((c): c is string => c !== null);
  if (caminhos.length === 0) return;
  try {
    await anexosStorageService.delete(caminhos);
  } catch (err) {
    console.error(
      "Falha ao remover arquivo(s) do Storage:",
      err instanceof Error ? err.message : err,
    );
  }
  await removerMetadadosDosAnexos(caminhos);
}

/** Apaga toda a pasta de anexos de uma checklist (best effort, ver acima). */
async function removerPastaDaChecklist(checklistId: string): Promise<void> {
  const limite = 1000;
  let offset = 0;
  const caminhos: string[] = [];
  for (;;) {
    const { data, error } = await anexosStorageService.list(checklistId, {
      limit: limite,
      offset,
    });
    if (error) {
      console.error("Falha ao listar pasta de anexos da checklist:", error.message);
      return;
    }
    if (!data || data.length === 0) break;
    for (const arquivo of data) {
      if (arquivo.id !== null) caminhos.push(`${checklistId}/${arquivo.name}`);
    }
    if (data.length < limite) break;
    offset += limite;
  }
  if (caminhos.length === 0) return;
  try {
    await anexosStorageService.delete(caminhos);
  } catch (err) {
    console.error(
      "Falha ao remover pasta de anexos do Storage:",
      err instanceof Error ? err.message : err,
    );
  }
  await removerMetadadosDosAnexos(caminhos);
}

// Vídeo gravado na hora (câmera) já sai limitado a ~20MB (ver
// captura-camera.tsx: DURACAO_MAX_VIDEO_S + VIDEO_BITS_POR_SEGUNDO) — sem
// teto aqui o upload de uma rede móvel ruim fica "pendurado" sem erro nem
// sucesso, e um anexo fora do padrão (ex.: PDF grande) não deveria passar
// disso mesmo assim.
const TAMANHO_MAX_ANEXO_MB = 20;
const TIMEOUT_UPLOAD_MS = 120_000;

/** Corre uma promessa contra um prazo — se estourar, rejeita com mensagem
 *  amigável em vez de deixar o upload pendurado pra sempre na tela. Não
 *  cancela o upload em si (o storage-js não expõe abort), só desiste de
 *  esperar por ele. */
function comTimeout<T>(promessa: Promise<T>, ms: number, mensagem: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(mensagem)), ms);
    promessa.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

type ChecklistWithItems = ChecklistRow & { checklist_items: ChecklistItemRow[] };

/**
 * Busca checklists + itens em uma única query (join implícito do Postgrest via
 * "checklist_items(*)"). Ordena checklists por horário e, dentro de cada uma,
 * os itens pela coluna "posicao" (ordem definida na criação/edição).
 */
async function fetchChecklists(): Promise<Checklist[]> {
  const { data, error } = await supabase
    .from("checklists")
    .select("*, checklist_items(*)")
    .order("nome", { ascending: true })
    .order("posicao", { referencedTable: "checklist_items", ascending: true })
    .returns<ChecklistWithItems[]>();

  if (error) throw error;

  return (data ?? [])
    .map((row) => {
      const itens: ChecklistItem[] = row.checklist_items.map((it) => ({
        id: it.id,
        titulo: it.titulo,
        status: it.status as ItemStatus,
        tipoTarefa: (it.tipo_tarefa ?? "checklist") as TipoTarefa,
        respostaOpcoes: [...(it.resposta_opcoes ?? [])],
        resposta: it.resposta ?? null,
        justificativa: it.justificativa ?? null,
        turno: it.turno ?? turnoDoHorario(it.horario_inicio?.slice(0, 5) ?? null),
        horarioInicio: it.horario_inicio ? it.horario_inicio.slice(0, 5) : null,
        horarioTermino: it.horario_termino ? it.horario_termino.slice(0, 5) : null,
        minAnexos: it.min_anexos ?? 0,
        maxAnexos: it.max_anexos ?? null,
        anexos: it.anexos ?? [],
        concluidoEm: it.concluido_em ?? null,
        recorrencia: (it.recorrencia ?? "semanal") as Recorrencia,
        diasSemana: [...(it.dias_semana ?? [])].sort((a, b) => a - b),
        inicio: it.inicio ?? null,
        ...(it.detalhe ? { detalhe: it.detalhe } : {}),
      }));
      const corteDia = row.corte_dia ? row.corte_dia.slice(0, 5) : undefined;
      return {
        id: row.id,
        nome: row.nome,
        responsavel: row.responsavel,
        ativo: row.ativo,
        reabreAutomatico: row.reabre_automatico ?? false,
        ...(row.reabre_intervalo_min ? { reabreIntervaloMin: row.reabre_intervalo_min } : {}),
        ...descricaoAgenda(itens, corteDia),
        ...(row.tempo_limite ? { tempoLimite: row.tempo_limite.slice(0, 5) } : {}),
        ...(corteDia ? { corteDia } : {}),
        criadoEm: (row.created_at ?? "").slice(0, 10),
        diasPausados: [...(row.dias_pausados ?? [])].sort(),
        itens,
      };
    })
    .sort(
      (a, b) =>
        (a.horarioInicio ?? "99:99").localeCompare(b.horarioInicio ?? "99:99") ||
        a.nome.localeCompare(b.nome),
    );
}

interface Ctx {
  checklists: Checklist[];
  isLoading: boolean;
  isError: boolean;
  toggleItem: (checklistId: string, itemId: string) => void;
  /** Enquete: grava a opção escolhida (não conclui sozinho). */
  responderEnquete: (checklistId: string, itemId: string, resposta: string) => void;
  /** Enquete: grava a justificativa/observação do responsável. */
  justificarItem: (checklistId: string, itemId: string, texto: string) => void;
  concluirTodos: (checklistId: string) => void;
  reabrir: (checklistId: string) => void;
  /** Sobe um arquivo para o Storage e acrescenta o anexo ao item. */
  anexarArquivo: (checklistId: string, itemId: string, arquivo: File) => Promise<void>;
  /** Remove um anexo do item (pela URL). */
  removerAnexo: (checklistId: string, itemId: string, url: string) => Promise<void>;
  criarChecklist: (input: ChecklistInput) => void;
  editarChecklist: (checklistId: string, input: ChecklistInput) => void;
  excluirChecklist: (checklistId: string) => void;
  /** Remove uma data de "diasPausados" — reabre a rotina naquele dia específico. */
  removerDiaPausado: (checklistId: string, iso: string) => void;
}

const GCheckContext = React.createContext<Ctx | null>(null);

export function GCheckProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  // "enabled: !!session" evita chamar o Supabase (e estourar RLS) antes do login terminar.
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: fetchChecklists, enabled: !!session });

  // Rede de segurança do reset diário: além do pg_cron, o client chama
  // rollover_pendente() ao abrir e de tempos em tempos (cobre a aba deixada
  // aberta virando a meia-noite). A função é idempotente no servidor.
  React.useEffect(() => {
    if (!session) return;
    let vivo = true;
    const rodar = () => {
      rolloverPendente()
        .then(() => {
          if (!vivo) return;
          queryClient.invalidateQueries({ queryKey: QUERY_KEY });
          queryClient.invalidateQueries({ queryKey: HISTORICO_QUERY_KEY });
        })
        .catch(() => {
          /* silencioso: o pg_cron cobre o caminho normal */
        });
    };
    rodar();
    const id = window.setInterval(rodar, 15 * 60 * 1000);
    return () => {
      vivo = false;
      window.clearInterval(id);
    };
  }, [session, queryClient]);

  // Reabertura automática (giro da Segurança etc.): o pg_cron roda a cada minuto;
  // aqui o client cobre a mesma janela para a tela de quem está com o app aberto.
  React.useEffect(() => {
    if (!session) return;
    let vivo = true;
    const rodar = () => {
      reabrirAutomaticas()
        .then(() => {
          if (!vivo) return;
          queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        })
        .catch(() => {
          /* silencioso: o pg_cron cobre o caminho normal */
        });
    };
    rodar();
    const id = window.setInterval(rodar, 60 * 1000);
    return () => {
      vivo = false;
      window.clearInterval(id);
    };
  }, [session, queryClient]);

  // Notificação por e-mail (rotina concluída/atrasada): o pg_cron roda a cada
  // 5 min; aqui o client cobre a mesma janela. Sem efeito colateral se a
  // Resend ainda não foi configurada — notificar_rotinas() só volta (no-op).
  React.useEffect(() => {
    if (!session) return;
    const rodar = () => {
      notificarRotinas().catch(() => {
        /* silencioso: o pg_cron cobre o caminho normal */
      });
    };
    rodar();
    const id = window.setInterval(rodar, 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [session]);

  const toggleItemMutation = useMutation({
    mutationFn: async ({ itemId, next }: { itemId: string; next: ItemStatus }) => {
      const { error } = await supabase
        .from("checklist_items")
        .update({ status: next })
        .eq("id", itemId);
      if (error) throw error;
    },
    onError: () => {
      toast.error("Não foi possível atualizar o item.");
      // Reverte a atualização otimista buscando o estado real do servidor.
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const toggleItem = React.useCallback(
    (checklistId: string, itemId: string) => {
      // Trava de anexos: não deixa concluir sem os anexos mínimos (reforçada
      // também por trigger no banco — ver migration 20260901120000).
      const atual = (queryClient.getQueryData<Checklist[]>(QUERY_KEY) ?? [])
        .find((c) => c.id === checklistId)
        ?.itens.find((i) => i.id === itemId);
      if (atual && atual.status !== "concluido" && atual.anexos.length < atual.minAnexos) {
        const faltam = atual.minAnexos - atual.anexos.length;
        toast.error(
          `Anexe ${faltam === atual.minAnexos ? "" : "mais "}${faltam} ${
            faltam === 1 ? "arquivo" : "arquivos"
          } para concluir esta tarefa.`,
        );
        return;
      }
      // Enquete: precisa de uma opção escolhida antes de concluir (trigger no
      // banco também barra — ver migration 20260905120000).
      if (
        atual &&
        atual.status !== "concluido" &&
        atual.tipoTarefa === "enquete" &&
        !atual.resposta
      ) {
        toast.error("Escolha uma resposta para concluir esta enquete.");
        return;
      }
      // Enquete: justificativa obrigatória antes de concluir (trigger no banco
      // também barra — ver migration 20260916130000).
      if (
        atual &&
        atual.status !== "concluido" &&
        atual.tipoTarefa === "enquete" &&
        !atual.justificativa?.trim()
      ) {
        toast.error("Preencha a justificativa para concluir esta enquete.");
        return;
      }

      let next: ItemStatus = "concluido";
      // Atualização otimista: aplica a mudança no cache do React Query antes da
      // resposta do servidor, para o toque no checkbox parecer instantâneo.
      // "next" é capturado pelo closure para ser reaproveitado na mutation abaixo.
      queryClient.setQueryData<Checklist[]>(QUERY_KEY, (prev) =>
        (prev ?? []).map((c) =>
          c.id !== checklistId
            ? c
            : {
                ...c,
                itens: c.itens.map((i) => {
                  if (i.id !== itemId) return i;
                  next = i.status === "concluido" ? "pendente" : "concluido";
                  return { ...i, status: next };
                }),
              },
        ),
      );
      toggleItemMutation.mutate({ itemId, next });
    },
    [queryClient, toggleItemMutation],
  );

  // Enquete: grava a resposta/justificativa e, quando a resposta já satisfaz a
  // tarefa (anexos mínimos já anexados), conclui junto — dispensa o checkbox.
  const patchItemMutation = useMutation({
    mutationFn: async ({
      itemId,
      patch,
    }: {
      checklistId: string;
      itemId: string;
      patch: { resposta?: string | null; justificativa?: string | null; status?: ItemStatus };
    }) => {
      const { error } = await supabase.from("checklist_items").update(patch).eq("id", itemId);
      if (error) throw error;
    },
    onError: () => {
      toast.error("Não foi possível salvar a resposta.");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const aplicarPatchNoCache = React.useCallback(
    (checklistId: string, itemId: string, patch: Partial<ChecklistItem>) => {
      queryClient.setQueryData<Checklist[]>(QUERY_KEY, (prev) =>
        (prev ?? []).map((c) =>
          c.id !== checklistId
            ? c
            : { ...c, itens: c.itens.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) },
        ),
      );
    },
    [queryClient],
  );

  const responderEnquete = React.useCallback(
    (checklistId: string, itemId: string, resposta: string) => {
      // Enquete não depende do check manual: escolher a opção já conclui a
      // tarefa, desde que os anexos mínimos (quando exigidos) e a justificativa
      // (obrigatória) já estejam preenchidos. Se ainda faltar algum, só grava a
      // resposta — a conclusão acontece no anexarArquivo/justificarItem, quando
      // o que faltava entra.
      const atual = (queryClient.getQueryData<Checklist[]>(QUERY_KEY) ?? [])
        .find((c) => c.id === checklistId)
        ?.itens.find((i) => i.id === itemId);
      const podeConcluir =
        !!atual &&
        atual.status !== "concluido" &&
        atual.anexos.length >= atual.minAnexos &&
        !!atual.justificativa?.trim();
      const patch = podeConcluir ? { resposta, status: "concluido" as ItemStatus } : { resposta };
      aplicarPatchNoCache(checklistId, itemId, patch);
      patchItemMutation.mutate({ checklistId, itemId, patch });
    },
    [aplicarPatchNoCache, patchItemMutation, queryClient],
  );

  const justificarItem = React.useCallback(
    (checklistId: string, itemId: string, texto: string) => {
      const valor = texto.trim() ? texto : null;
      // Espelha responderEnquete/anexarArquivo: se a justificativa é a última
      // peça que faltava (resposta e anexos mínimos já ok), conclui junto.
      const atual = (queryClient.getQueryData<Checklist[]>(QUERY_KEY) ?? [])
        .find((c) => c.id === checklistId)
        ?.itens.find((i) => i.id === itemId);
      const podeConcluir =
        !!atual &&
        atual.status !== "concluido" &&
        atual.tipoTarefa === "enquete" &&
        !!atual.resposta &&
        atual.anexos.length >= atual.minAnexos &&
        !!valor?.trim();
      const patch = podeConcluir
        ? { justificativa: valor, status: "concluido" as ItemStatus }
        : { justificativa: valor };
      aplicarPatchNoCache(checklistId, itemId, patch);
      patchItemMutation.mutate({ checklistId, itemId, patch });
    },
    [aplicarPatchNoCache, patchItemMutation, queryClient],
  );

  const concluirTodosMutation = useMutation({
    mutationFn: async (checklistId: string) => {
      const { error } = await supabase
        .from("checklist_items")
        .update({ status: "concluido" })
        .eq("checklist_id", checklistId);
      if (error) throw error;
    },
    onError: () => {
      toast.error("Não foi possível concluir a rotina.");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const concluirTodos = React.useCallback(
    (checklistId: string) => {
      // "Concluir rotina" não fura a regra de anexos: se algum item pendente
      // ainda não tem os anexos mínimos, aborta e avisa quais faltam.
      const itens = (queryClient.getQueryData<Checklist[]>(QUERY_KEY) ?? []).find(
        (c) => c.id === checklistId,
      )?.itens;
      const pendentesSemAnexo = itens?.filter(
        (i) => i.status !== "concluido" && i.anexos.length < i.minAnexos,
      );
      if (pendentesSemAnexo && pendentesSemAnexo.length > 0) {
        toast.error(`Faltam anexos em: ${pendentesSemAnexo.map((i) => i.titulo).join(", ")}`);
        return;
      }
      const enquetesSemResposta = itens?.filter(
        (i) => i.status !== "concluido" && i.tipoTarefa === "enquete" && !i.resposta,
      );
      if (enquetesSemResposta && enquetesSemResposta.length > 0) {
        toast.error(`Falta responder: ${enquetesSemResposta.map((i) => i.titulo).join(", ")}`);
        return;
      }
      const enquetesSemJustificativa = itens?.filter(
        (i) => i.status !== "concluido" && i.tipoTarefa === "enquete" && !i.justificativa?.trim(),
      );
      if (enquetesSemJustificativa && enquetesSemJustificativa.length > 0) {
        toast.error(
          `Falta justificar: ${enquetesSemJustificativa.map((i) => i.titulo).join(", ")}`,
        );
        return;
      }

      queryClient.setQueryData<Checklist[]>(QUERY_KEY, (prev) =>
        (prev ?? []).map((c) =>
          c.id !== checklistId
            ? c
            : { ...c, itens: c.itens.map((i) => ({ ...i, status: "concluido" as ItemStatus })) },
        ),
      );
      concluirTodosMutation.mutate(checklistId);
    },
    [queryClient, concluirTodosMutation],
  );

  const reabrirMutation = useMutation({
    mutationFn: async (checklistId: string) => {
      const { error } = await supabase
        .from("checklist_items")
        .update({ status: "pendente" })
        .eq("checklist_id", checklistId);
      if (error) throw error;
    },
    onError: () => {
      toast.error("Não foi possível reabrir a rotina.");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const reabrir = React.useCallback(
    (checklistId: string) => {
      queryClient.setQueryData<Checklist[]>(QUERY_KEY, (prev) =>
        (prev ?? []).map((c) =>
          c.id !== checklistId
            ? c
            : { ...c, itens: c.itens.map((i) => ({ ...i, status: "pendente" as ItemStatus })) },
        ),
      );
      reabrirMutation.mutate(checklistId);
    },
    [queryClient, reabrirMutation],
  );

  const setAnexosNoCache = React.useCallback(
    (checklistId: string, itemId: string, anexos: Anexo[]) => {
      queryClient.setQueryData<Checklist[]>(QUERY_KEY, (prev) =>
        (prev ?? []).map((c) => {
          if (c.id !== checklistId) return c;
          return {
            ...c,
            itens: c.itens.map((i) => (i.id === itemId ? { ...i, anexos } : i)),
          };
        }),
      );
    },
    [queryClient],
  );

  /** Anexos atuais do item, lidos do cache do React Query. */
  const anexosDoItem = React.useCallback(
    (checklistId: string, itemId: string): Anexo[] =>
      (queryClient.getQueryData<Checklist[]>(QUERY_KEY) ?? [])
        .find((c) => c.id === checklistId)
        ?.itens.find((i) => i.id === itemId)?.anexos ?? [],
    [queryClient],
  );

  const anexarArquivoMutation = useMutation({
    mutationFn: async ({
      itemId,
      checklistId,
      arquivo,
    }: {
      checklistId: string;
      itemId: string;
      arquivo: File;
    }) => {
      // Teto de anexos: bloqueia antes do upload (trigger no banco também barra).
      const item = (queryClient.getQueryData<Checklist[]>(QUERY_KEY) ?? [])
        .find((c) => c.id === checklistId)
        ?.itens.find((i) => i.id === itemId);
      if (item?.maxAnexos != null && item.anexos.length >= item.maxAnexos) {
        throw new Error(`Este item aceita no máximo ${item.maxAnexos} arquivo(s).`);
      }
      if (arquivo.size > TAMANHO_MAX_ANEXO_MB * 1024 * 1024) {
        throw new Error(
          `Arquivo muito grande (máx. ${TAMANHO_MAX_ANEXO_MB}MB) — grave um vídeo mais curto ou em qualidade menor.`,
        );
      }
      const ext =
        arquivo.name
          .split(".")
          .pop()
          ?.toLowerCase()
          .replace(/[^a-z0-9]/g, "") || "bin";
      const caminho = `${checklistId}/${itemId}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;
      const resultadoUpload = await comTimeout(
        anexosStorageService.upload(caminho, arquivo),
        TIMEOUT_UPLOAD_MS,
        "Envio muito lento — verifique sua conexão e tente novamente.",
      );

      // Metadados (tamanho, mime, expiração) na tabela dedicada — melhor
      // esforço: se falhar, o trigger `anexos_registrar_novos` (banco) ainda
      // registra a linha (sem size_bytes) quando o UPDATE abaixo gravar o
      // jsonb, e o cron de limpeza cobre o resto.
      const { error: metadadosError } = await supabase.from("anexos").insert({
        checklist_item_id: itemId,
        storage_path: resultadoUpload.path,
        mime_type: resultadoUpload.mimeType,
        nome_original: arquivo.name,
        size_bytes: resultadoUpload.sizeBytes,
      });
      if (metadadosError) {
        console.error("Falha ao registrar metadados do anexo:", metadadosError.message);
      }

      const { data } = supabase.storage.from(BUCKET_ANEXOS).getPublicUrl(caminho);
      const novo: Anexo = {
        url: data.publicUrl,
        tipo: arquivo.type || "application/octet-stream",
        nome: arquivo.name,
      };

      // Acrescenta ao array atual e regrava a lista inteira.
      const proximos = [...anexosDoItem(checklistId, itemId), novo];
      // Enquete já respondida e justificada: o anexo que fecha o mínimo exigido
      // conclui a tarefa junto — sem depender do checkbox (mesma regra do
      // responderEnquete/justificarItem).
      const concluiJunto =
        item?.tipoTarefa === "enquete" &&
        item.status !== "concluido" &&
        !!item.resposta &&
        !!item.justificativa?.trim() &&
        proximos.length >= item.minAnexos;
      const { error: updateError } = await supabase
        .from("checklist_items")
        .update(concluiJunto ? { anexos: proximos, status: "concluido" } : { anexos: proximos })
        .eq("id", itemId);
      if (updateError) throw updateError;

      return { checklistId, itemId, proximos, concluiJunto };
    },
    onSuccess: ({ checklistId, itemId, proximos, concluiJunto }) => {
      setAnexosNoCache(checklistId, itemId, proximos);
      if (concluiJunto) aplicarPatchNoCache(checklistId, itemId, { status: "concluido" });
      toast.success("Arquivo anexado.");
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Não foi possível anexar o arquivo."),
  });

  const removerAnexoMutation = useMutation({
    mutationFn: async ({
      itemId,
      checklistId,
      url,
    }: {
      checklistId: string;
      itemId: string;
      url: string;
    }) => {
      const proximos = anexosDoItem(checklistId, itemId).filter((a) => a.url !== url);
      const { error } = await supabase
        .from("checklist_items")
        .update({ anexos: proximos })
        .eq("id", itemId);
      if (error) throw error;
      await removerArquivosDosAnexos([{ url }]);
      return { checklistId, itemId, proximos };
    },
    onSuccess: ({ checklistId, itemId, proximos }) => {
      setAnexosNoCache(checklistId, itemId, proximos);
      toast.success("Anexo removido.");
    },
    onError: () => toast.error("Não foi possível remover o anexo."),
  });

  const anexarArquivo = React.useCallback(
    async (checklistId: string, itemId: string, arquivo: File) => {
      await anexarArquivoMutation.mutateAsync({ checklistId, itemId, arquivo });
    },
    [anexarArquivoMutation],
  );

  const removerAnexo = React.useCallback(
    async (checklistId: string, itemId: string, url: string) => {
      await removerAnexoMutation.mutateAsync({ checklistId, itemId, url });
    },
    [removerAnexoMutation],
  );

  const criarChecklistMutation = useMutation({
    mutationFn: async (input: ChecklistInput) => {
      // Id da checklist é o slug do nome; se já existir (mesmo nome usado antes),
      // acrescenta um sufixo numérico até achar um id livre.
      const existentes = (queryClient.getQueryData<Checklist[]>(QUERY_KEY) ?? []).map((c) => c.id);
      const baseId = slugify(input.nome) || "checklist";
      let id = baseId;
      let sufixo = 2;
      while (existentes.includes(id)) id = `${baseId}-${sufixo++}`;

      const { error: checklistError } = await supabase.from("checklists").insert({
        id,
        nome: input.nome,
        responsavel: input.responsavel,
        ativo: input.ativo,
        tempo_limite: input.tempoLimite ?? null,
        corte_dia: input.corteDia ?? null,
        reabre_automatico: input.reabreAutomatico,
        reabre_intervalo_min: input.reabreAutomatico ? (input.reabreIntervaloMin ?? null) : null,
        dias_pausados: input.diasPausados,
      });
      if (checklistError) throw checklistError;

      // Ids dos itens seguem "<id-da-checklist>-<posição>" — todo item nasce "pendente".
      const itensPayload = ordenarPorHorario(input.itens, input.corteDia).map((it, index) => ({
        id: `${id}-${index + 1}`,
        checklist_id: id,
        ...camposItemBanco(it),
        status: "pendente",
        posicao: index + 1,
        anexos: [],
      }));

      const { error: itensError } = await supabase.from("checklist_items").insert(itensPayload);
      if (itensError) {
        // Não há transação entre as duas tabelas, então se os itens falharem
        // desfazemos manualmente a checklist já inserida para não deixar lixo órfão.
        await supabase.from("checklists").delete().eq("id", id);
        throw itensError;
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: () => toast.error("Não foi possível criar a checklist."),
  });

  const criarChecklist = React.useCallback(
    (input: ChecklistInput) => {
      criarChecklistMutation.mutate(input);
    },
    [criarChecklistMutation],
  );

  const editarChecklistMutation = useMutation({
    mutationFn: async ({ checklistId, input }: { checklistId: string; input: ChecklistInput }) => {
      const atual = (queryClient.getQueryData<Checklist[]>(QUERY_KEY) ?? []).find(
        (c) => c.id === checklistId,
      );
      const statusPorId = new Map((atual?.itens ?? []).map((i) => [i.id, i.status]));
      // Preserva os anexos já enviados hoje quando o item sobrevive à edição.
      const anexosPorId = new Map((atual?.itens ?? []).map((i) => [i.id, i.anexos ?? []] as const));
      const idsUsados = new Set<string>();

      // Reconciliação de itens: o form manda "itemId" para itens que já existiam
      // (checklist-form-dialog.tsx) e nada para itens novos. Aqui reaproveitamos o
      // id original — e portanto o status ("concluido"/"pendente") — sempre que ele
      // ainda existe e não foi usado por outro item nesta mesma edição; caso
      // contrário (item novo, ou id duplicado/inválido) geramos um UUID novo, que
      // sempre nasce "pendente". Isso evita resetar o progresso já feito ao editar.
      const itensFinal = ordenarPorHorario(input.itens, input.corteDia).map((it, index) => {
        let id = it.id && statusPorId.has(it.id) && !idsUsados.has(it.id) ? it.id : undefined;
        if (!id) id = crypto.randomUUID();
        idsUsados.add(id);

        return {
          id,
          checklist_id: checklistId,
          ...camposItemBanco(it),
          status: statusPorId.get(id) ?? "pendente",
          posicao: index + 1,
          anexos: anexosPorId.get(id) ?? [],
        };
      });

      // Itens que existiam antes mas não estão mais na lista final são removidos.
      const idsFinal = new Set(itensFinal.map((i) => i.id));
      const idsRemover = (atual?.itens ?? []).map((i) => i.id).filter((id) => !idsFinal.has(id));

      const { error: checklistError } = await supabase
        .from("checklists")
        .update({
          nome: input.nome,
          responsavel: input.responsavel,
          ativo: input.ativo,
          tempo_limite: input.tempoLimite ?? null,
          corte_dia: input.corteDia ?? null,
          reabre_automatico: input.reabreAutomatico,
          reabre_intervalo_min: input.reabreAutomatico ? (input.reabreIntervaloMin ?? null) : null,
          dias_pausados: input.diasPausados,
        })
        .eq("id", checklistId);
      if (checklistError) throw checklistError;

      if (idsRemover.length) {
        const { error: deleteError } = await supabase
          .from("checklist_items")
          .delete()
          .in("id", idsRemover);
        if (deleteError) throw deleteError;
        const anexosRemovidos = idsRemover.flatMap((id) => anexosPorId.get(id) ?? []);
        await removerArquivosDosAnexos(anexosRemovidos);
      }

      const { error: upsertError } = await supabase.from("checklist_items").upsert(itensFinal);
      if (upsertError) throw upsertError;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: () => toast.error("Não foi possível salvar as alterações."),
  });

  const editarChecklist = React.useCallback(
    (checklistId: string, input: ChecklistInput) => {
      editarChecklistMutation.mutate({ checklistId, input });
    },
    [editarChecklistMutation],
  );

  const excluirChecklistMutation = useMutation({
    mutationFn: async (checklistId: string) => {
      // checklist_items tem "on delete cascade" no checklist_id, então apagar a
      // checklist remove os itens junto — não precisa deletar itens à mão.
      const { error } = await supabase.from("checklists").delete().eq("id", checklistId);
      if (error) throw error;
      await removerPastaDaChecklist(checklistId);
    },
    onSuccess: () => toast.success("Checklist excluída."),
    onError: () => {
      toast.error("Não foi possível excluir a checklist.");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const excluirChecklist = React.useCallback(
    (checklistId: string) => {
      // Remoção otimista: tira a checklist do cache antes da resposta do servidor.
      queryClient.setQueryData<Checklist[]>(QUERY_KEY, (prev) =>
        (prev ?? []).filter((c) => c.id !== checklistId),
      );
      excluirChecklistMutation.mutate(checklistId);
    },
    [queryClient, excluirChecklistMutation],
  );

  // Ação rápida no card bloqueado: tira só aquela data de diasPausados, sem
  // precisar abrir o formulário de edição inteiro (que mexe também nos itens).
  const removerDiaPausadoMutation = useMutation({
    mutationFn: async ({ checklistId, iso }: { checklistId: string; iso: string }) => {
      const atual = (queryClient.getQueryData<Checklist[]>(QUERY_KEY) ?? []).find(
        (c) => c.id === checklistId,
      );
      const proximos = (atual?.diasPausados ?? []).filter((d) => d !== iso);
      const { error } = await supabase
        .from("checklists")
        .update({ dias_pausados: proximos })
        .eq("id", checklistId);
      if (error) throw error;
      return { checklistId, proximos };
    },
    onSuccess: ({ checklistId, proximos }) => {
      queryClient.setQueryData<Checklist[]>(QUERY_KEY, (prev) =>
        (prev ?? []).map((c) => (c.id === checklistId ? { ...c, diasPausados: proximos } : c)),
      );
      toast.success("Dia de folga removido — a rotina volta a valer normalmente.");
    },
    onError: () => {
      toast.error("Não foi possível remover o dia de folga.");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const removerDiaPausado = React.useCallback(
    (checklistId: string, iso: string) => {
      removerDiaPausadoMutation.mutate({ checklistId, iso });
    },
    [removerDiaPausadoMutation],
  );

  const value = React.useMemo(
    () => ({
      checklists: query.data ?? [],
      isLoading: query.isLoading,
      isError: query.isError,
      toggleItem,
      responderEnquete,
      justificarItem,
      concluirTodos,
      reabrir,
      anexarArquivo,
      removerAnexo,
      criarChecklist,
      editarChecklist,
      excluirChecklist,
      removerDiaPausado,
    }),
    [
      query.data,
      query.isLoading,
      query.isError,
      toggleItem,
      responderEnquete,
      justificarItem,
      concluirTodos,
      reabrir,
      anexarArquivo,
      removerAnexo,
      criarChecklist,
      editarChecklist,
      excluirChecklist,
      removerDiaPausado,
    ],
  );

  return <GCheckContext.Provider value={value}>{children}</GCheckContext.Provider>;
}

export function useGCheck() {
  const ctx = React.useContext(GCheckContext);
  if (!ctx) throw new Error("useGCheck deve ser usado dentro de GCheckProvider");
  return ctx;
}

/** Contagem de itens concluídos/pendentes e percentual — usado no dashboard e nas cards. */
export function progresso(c: Checklist) {
  const total = c.itens.length;
  const feitos = c.itens.filter((i) => i.status === "concluido").length;
  return {
    total,
    feitos,
    pendentes: total - feitos,
    pct: total ? Math.round((feitos / total) * 100) : 0,
  };
}

/**
 * Agregado de tarefas (itens de checklist) por uma chave — nome do responsável
 * da rotina. Alimenta a tabela do dashboard ("tarefas por funcionário") e o
 * contador na página de funcionários.
 */
export interface AgregadoTarefas {
  chave: string;
  total: number;
  feitos: number;
  /** Todos os itens não concluídos (inclui os atrasados). */
  pendentes: number;
  /** Subconjunto de "pendentes" cuja checklist já passou do tempo limite. */
  atrasados: number;
}

/**
 * Percorre os itens das checklists ativas somando por chave. Com `naData`, só
 * conta as atividades programadas para aquele dia (recorrência por item).
 */
function agregaTarefas(
  checklists: Checklist[],
  chaveDoItem: (item: ChecklistItem, checklist: Checklist) => string,
  naData?: Date,
): AgregadoTarefas[] {
  const mapa = new Map<string, AgregadoTarefas>();
  for (const c of checklists) {
    if (!c.ativo) continue;
    const cAtrasada = estado(c) === "atrasada";
    for (const i of c.itens) {
      if (naData && !itemRodaNoDia(i, naData)) continue;
      const chave = chaveDoItem(i, c).trim();
      if (!chave) continue;
      const atual = mapa.get(chave) ?? { chave, total: 0, feitos: 0, pendentes: 0, atrasados: 0 };
      atual.total += 1;
      if (i.status === "concluido") {
        atual.feitos += 1;
      } else {
        atual.pendentes += 1;
        if (cAtrasada) atual.atrasados += 1;
      }
      mapa.set(chave, atual);
    }
  }
  // Mais atrasados primeiro, depois mais pendências; empata por volume e nome.
  return [...mapa.values()].sort(
    (a, b) =>
      b.atrasados - a.atrasados ||
      b.pendentes - a.pendentes ||
      b.total - a.total ||
      a.chave.localeCompare(b.chave),
  );
}

export function tarefasPorFuncionario(checklists: Checklist[], naData?: Date) {
  return agregaTarefas(checklists, (_i, c) => c.responsavel, naData);
}

/** Acha o agregado de uma chave (ignora caixa/espaços); devolve zerado se não houver. */
export function resumoDe(agregados: AgregadoTarefas[], chave: string): AgregadoTarefas {
  const alvo = chave.trim().toLowerCase();
  return (
    agregados.find((a) => a.chave.trim().toLowerCase() === alvo) ?? {
      chave,
      total: 0,
      feitos: 0,
      pendentes: 0,
      atrasados: 0,
    }
  );
}

/** A rotina está de folga nesta data (dia marcado no cadastro dela)? */
export function checklistPausadaNoDia(c: Pick<Checklist, "diasPausados">, data: Date): boolean {
  return c.diasPausados.includes(isoDoDia(data));
}

/**
 * A rotina tem ao menos uma atividade programada para esta data? Fora disso a
 * rotina conta como "desativada" naquele dia — não é cobrada no dashboard, não
 * abre na lista. A regra por atividade está em `itemRodaNoDia` (lib/recorrencia);
 * um dia de folga cadastrado na rotina (`diasPausados`) também desativa o dia
 * inteiro, mesmo que algum item bateria a recorrência normalmente.
 */
export function checklistRodaNoDia(c: Checklist, data: Date = new Date()): boolean {
  if (checklistPausadaNoDia(c, data)) return false;
  return c.itens.some((i) => itemRodaNoDia(i, data));
}

/**
 * "Dia operacional" de uma rotina — normalmente é `agora`, mas rotinas com
 * `corteDia` (turno que atravessa a meia-noite, ex.: 23:00-06:00) ainda
 * contam como o dia anterior até esse horário passar. Usado para recortar
 * "as atividades de hoje" sem resetar/travar o turno da madrugada no meio do
 * expediente — espelha `dia_operacional_checklist` no banco (ver migration
 * 20260921120000_corte_dia_rotina_noturna.sql).
 */
export function diaOperacionalChecklist(
  c: Pick<Checklist, "corteDia">,
  agora: Date = new Date(),
): Date {
  if (!c.corteDia) return agora;
  const [h, m] = c.corteDia.split(":").map(Number);
  const corteMin = (h ?? 0) * 60 + (m ?? 0);
  // Hora "de Brasília", não a do fuso do dispositivo/servidor — ver `paraFusoLoja`.
  const zonado = paraFusoLoja(agora);
  const agoraMin = zonado.getUTCHours() * 60 + zonado.getUTCMinutes();
  if (agoraMin >= corteMin) return agora;
  // "Ontem" no calendário da loja, como meia-noite local — mesma convenção de
  // Date usada pro resto do app em datas "de calendário" (ver `dataDoIso`).
  return new Date(zonado.getUTCFullYear(), zonado.getUTCMonth(), zonado.getUTCDate() - 1);
}

/**
 * A rotina já existia nesta data? A recorrência (semanal/quinzenal/mensal) se
 * repete "para sempre" nos dois sentidos do tempo; sem essa checagem o
 * calendário projeta a rotina em dias anteriores à sua criação — dias em que
 * ela nunca existiu. `criadoEm` pode vir vazio (dado antigo): aí não trava.
 */
export function checklistVigenteNoDia(c: Checklist, data: Date): boolean {
  if (!c.criadoEm) return true;
  return isoDoDia(data) >= c.criadoEm;
}

export type ChecklistEstado = "concluido" | "em_andamento" | "pendente" | "atrasada";

/**
 * Minutos desde a meia-noite de um "HH:MM" (horário de Brasília, digitado como
 * texto) ou de um Date (instante real — convertido pro horário de Brasília
 * antes de extrair hora/minuto, senão o resultado muda conforme o fuso do
 * dispositivo/servidor que está rodando o código — ver `paraFusoLoja`).
 */
function minutosDoDia(v: string | Date): number {
  if (typeof v === "string") {
    const [h, m] = v.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  }
  const zonado = paraFusoLoja(v);
  return zonado.getUTCHours() * 60 + zonado.getUTCMinutes();
}

/**
 * Minutos de `v` num relógio que começa no `corteDia` da rotina, não na
 * meia-noite — ex.: corte 08:00 → 08:00 vira o minuto 0 do ciclo e 07:59 do
 * dia seguinte vira o último minuto (1439). Sem `corteDia`, é o mesmo que
 * `minutosDoDia`. Necessário pra comparar "atrasada"/"não iniciada" numa
 * rotina cujo horário atravessa a meia-noite (ex.: início 20:00, término
 * 07:30): comparando os minutos crus, 07:30 (450) pareceria "antes" de 20:00
 * (1200) e a rotina nasceria "atrasada" assim que o turno começasse à noite.
 * Com o ciclo baseado no corte, 20:00 vira minuto 720 e 07:30 vira minuto
 * 1410 — a ordem do turno fica certa.
 */
export function minutosNoCiclo(v: string | Date, corteDia?: string): number {
  const min = minutosDoDia(v);
  if (!corteDia) return min;
  const diff = min - minutosDoDia(corteDia);
  return diff < 0 ? diff + 1440 : diff;
}

/** Horário limite efetivo da rotina: `tempoLimite` manual ou o último término dos itens. */
export function limiteDaRotina(
  c: Pick<Checklist, "tempoLimite" | "horarioTermino">,
): string | undefined {
  return c.tempoLimite ?? c.horarioTermino;
}

/**
 * Prazo efetivo de UMA atividade: o horário dela mesma (término, ou início
 * quando não tem término) — só na falta dos dois cai no horário limite da
 * rotina inteira (`tempoLimite`/último término). Cada atividade pode ter seu
 * próprio prazo dentro da mesma rotina.
 */
export function prazoDoItem(
  i: Pick<ChecklistItem, "horarioInicio" | "horarioTermino">,
  c: Pick<Checklist, "tempoLimite" | "horarioTermino">,
): string | undefined {
  return i.horarioTermino ?? i.horarioInicio ?? limiteDaRotina(c);
}

/**
 * Situação de uma atividade para revisão (ex.: no dia seguinte, no
 * histórico): além de feito/não feito, se passou do prazo dela — "atrasada"
 * quando ainda pendente, ou "concluida_atrasada" quando foi concluída depois
 * da hora (ainda conta como concluída, só fica marcada). Sem prazo definido
 * (nem no item, nem na rotina), nunca atrasa — só pendente/concluída no prazo.
 * `agora` é injetável para testes. Compara no ciclo do `corteDia` da rotina
 * (ver `minutosNoCiclo`) — sem isso, um item de madrugada (ex.: prazo 07:30)
 * nasceria "atrasado" assim que o turno da noite começasse.
 */
export type SituacaoItem = "pendente" | "atrasada" | "concluida_no_prazo" | "concluida_atrasada";

export function situacaoItem(
  i: Pick<ChecklistItem, "status" | "horarioInicio" | "horarioTermino" | "concluidoEm">,
  c: Pick<Checklist, "tempoLimite" | "horarioTermino" | "corteDia">,
  agora: Date = new Date(),
): SituacaoItem {
  const prazo = prazoDoItem(i, c);
  if (i.status === "concluido") {
    if (!prazo || !i.concluidoEm) return "concluida_no_prazo";
    return minutosNoCiclo(new Date(i.concluidoEm), c.corteDia) > minutosNoCiclo(prazo, c.corteDia)
      ? "concluida_atrasada"
      : "concluida_no_prazo";
  }
  if (!prazo) return "pendente";
  return minutosNoCiclo(agora, c.corteDia) > minutosNoCiclo(prazo, c.corteDia) ? "atrasada" : "pendente";
}

/**
 * Deriva o estado da checklist a partir do progresso — não é um campo salvo no
 * banco. "atrasada": passou do horário limite (tempo_limite manual ou o último
 * término dos itens) e a rotina não terminou. `agora` é injetável para testes.
 * Compara no ciclo do `corteDia` (ver `minutosNoCiclo`) — sem isso, uma
 * rotina noturna (ex.: início 20:00, limite 07:30) nasceria "atrasada" assim
 * que o turno começasse, porque 07:30 cru é "menor" que 20:00.
 */
export function estado(c: Checklist, agora: Date = new Date()): ChecklistEstado {
  const { feitos, total } = progresso(c);
  if (total > 0 && feitos === total) return "concluido";
  const limite = limiteDaRotina(c);
  if (limite && minutosNoCiclo(agora, c.corteDia) > minutosNoCiclo(limite, c.corteDia)) return "atrasada";
  if (feitos === 0) return "pendente";
  return "em_andamento";
}

export const estadoLabel: Record<ChecklistEstado, string> = {
  concluido: "Concluído",
  em_andamento: "Pendente",
  pendente: "Não iniciado",
  atrasada: "Atrasada",
};

/**
 * Rotina ainda "não iniciada": nada foi feito, está no prazo e o horário de
 * início ainda não chegou. Enquanto está nesse ponto, o painel não a cobra —
 * fica fora de pendências, taxa de execução e da quebra por funcionário.
 * A partir do horário (mesmo sem nenhum item feito) ela passa a contar.
 */
export function naoIniciada(c: Checklist, agora: Date = new Date()): boolean {
  if (estado(c, agora) !== "pendente") return false;
  // Sem horário de início nos itens não há "janela futura": a rotina já conta.
  if (!c.horarioInicio) return false;
  return minutosNoCiclo(agora, c.corteDia) < minutosNoCiclo(c.horarioInicio, c.corteDia);
}

/** Compara o responsável da rotina com o nome de perfil informado (ignora caixa e espaços). */
export function ehResponsavel(checklist: Pick<Checklist, "responsavel">, nome?: string | null) {
  if (!nome) return false;
  return checklist.responsavel.trim().toLowerCase() === nome.trim().toLowerCase();
}
