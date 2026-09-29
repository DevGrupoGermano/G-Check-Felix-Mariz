import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";

import { supabase, type ChecklistExecucaoRow } from "@/lib/supabase";
import { dataDoIso, isoDoDia } from "@/lib/utils";
import { itemRodaNoDia } from "@/lib/recorrencia";
import {
  checklistPausadaNoDia,
  descricaoAgenda,
  limiteDaRotina,
  minutosNoCiclo,
  type Checklist,
} from "@/lib/g-check-store";

/**
 * Turnos + horário de início a partir dos itens do snapshot. `corteDia` é o
 * da rotina viva correspondente (`Checklist.corteDia`) — sem ele, uma rotina
 * que atravessa a meia-noite mostraria o horário de algum item da madrugada
 * como se fosse o início do turno. Ver `descricaoAgenda`.
 */
export function agendaDoSnapshot(
  e: ChecklistExecucaoRow,
  corteDia?: string,
): { turno: string; horario: string } {
  const itens = (e.itens ?? []).map((i) => ({
    turno: i.turno ?? null,
    horarioInicio: i.horario_inicio ? i.horario_inicio.slice(0, 5) : null,
    horarioTermino: i.horario_termino ? i.horario_termino.slice(0, 5) : null,
  }));
  const agenda = descricaoAgenda(itens, corteDia);
  return { turno: agenda.turnos.join(" · "), horario: agenda.horarioInicio ?? "" };
}

export const HISTORICO_QUERY_KEY = ["historico"] as const;

/** Execuções registradas no intervalo [deISO, ateISO] (inclusive). */
export async function fetchExecucoes(
  deISO: string,
  ateISO: string,
): Promise<ChecklistExecucaoRow[]> {
  const { data, error } = await supabase
    .from("checklist_execucoes")
    .select("*")
    .gte("data", deISO)
    .lte("data", ateISO)
    .order("data", { ascending: true })
    .order("nome", { ascending: true })
    .returns<ChecklistExecucaoRow[]>();
  if (error) throw error;
  return data ?? [];
}

/**
 * Fecha o(s) dia(s) pendente(s) e reinicia as checklists. Idempotente no
 * servidor — chamar à toa (ao abrir o app / no foco) é barato quando já rodou.
 */
export async function rolloverPendente(): Promise<void> {
  const { error } = await supabase.rpc("rollover_pendente");
  if (error) throw error;
}

/**
 * Reabre (volta para 'pendente') as rotinas com reabertura automática cujo
 * intervalo já venceu. Idempotente no servidor — o pg_cron cobre o caminho
 * normal; o client chama de tempos em tempos como rede de segurança.
 */
export async function reabrirAutomaticas(): Promise<void> {
  const { error } = await supabase.rpc("reabrir_automaticas");
  if (error) throw error;
}

/**
 * Manda e-mail (via Resend) pros admins quando uma rotina bate 100% ou passa
 * do horário limite sem terminar — no máximo 1 e-mail por rotina/dia/tipo
 * (checklist_notificacoes). Idempotente no servidor — o pg_cron cobre o
 * caminho normal; o client chama de tempos em tempos como rede de segurança.
 * Sem custo se resend_api_key ainda não foi configurada no Vault (no-op).
 */
export async function notificarRotinas(): Promise<void> {
  const { error } = await supabase.rpc("notificar_rotinas");
  if (error) throw error;
}

export type StatusHistorico =
  | "futura"
  | "naoIniciada"
  | "hoje"
  | "incompleta"
  | "completa";

export interface EntradaHistorico {
  checklistId: string;
  nome: string;
  responsavel: string;
  turno: string;
  /** "HH:MM". */
  horario: string;
  total: number;
  feitos: number;
  status: StatusHistorico;
}

export interface DiaHistorico {
  iso: string;
  data: Date;
  /** Dia marcado como sem expediente (dias_desativados) — não teve rotina. */
  pausado: boolean;
  entradas: EntradaHistorico[];
}

/**
 * Combina o que já aconteceu (checklist_execucoes) com o estado ao vivo de hoje
 * e o agendamento futuro (checklist.diasSemana) numa lista dia a dia:
 *
 * - passado  -> a partir do snapshot: completa (verde) ou incompleta (vermelho)
 * - hoje     -> ao vivo: tudo feito = completa (verde); nada feito = não iniciada
 *              (cinza); algum item feito = em andamento (azul)
 * - futuro   -> agendada (cinza)
 * - pausado  -> dia sem expediente, sem entradas
 */
export function montarHistorico(opts: {
  de: Date;
  ate: Date;
  hojeISO: string;
  execucoes: ChecklistExecucaoRow[];
  checklists: Checklist[];
  diasDesativados: Set<string>;
}): DiaHistorico[] {
  const { de, ate, hojeISO, execucoes, checklists, diasDesativados } = opts;

  const exPorDia = new Map<string, ChecklistExecucaoRow[]>();
  for (const e of execucoes) {
    const arr = exPorDia.get(e.data);
    if (arr) arr.push(e);
    else exPorDia.set(e.data, [e]);
  }

  const ativas = checklists.filter((c) => c.ativo);
  // corteDia por id de rotina — o snapshot (checklist_execucoes) não guarda
  // isso, só a rotina viva. Ver agendaDoSnapshot.
  const corteDiaPorChecklist = new Map(checklists.map((c) => [c.id, c.corteDia]));
  const dias: DiaHistorico[] = [];

  const cursor = new Date(de.getFullYear(), de.getMonth(), de.getDate());
  const fim = new Date(ate.getFullYear(), ate.getMonth(), ate.getDate());

  while (cursor <= fim) {
    const iso = isoDoDia(cursor);
    const pausado = diasDesativados.has(iso);
    let entradas: EntradaHistorico[] = [];

    if (pausado) {
      entradas = [];
    } else if (iso < hojeISO) {
      entradas = (exPorDia.get(iso) ?? [])
        .slice()
        .map((e) => ({ e, agenda: agendaDoSnapshot(e, corteDiaPorChecklist.get(e.checklist_id)) }))
        .sort(
          (a, b) =>
            a.agenda.horario.localeCompare(b.agenda.horario) || a.e.nome.localeCompare(b.e.nome),
        )
        .map(({ e, agenda }) => ({
          checklistId: e.checklist_id,
          nome: e.nome,
          responsavel: e.itens[0]?.responsavel ?? "",
          turno: agenda.turno,
          horario: agenda.horario,
          total: e.total_itens,
          feitos: e.itens_concluidos,
          status: e.completa ? ("completa" as const) : ("incompleta" as const),
        }));
    } else {
      const diaRef = new Date(cursor);
      const agora = new Date();
      entradas = ativas
        .map((c) => ({
          c,
          itensDoDia: checklistPausadaNoDia(c, diaRef)
            ? []
            : c.itens.filter((i) => itemRodaNoDia(i, diaRef)),
        }))
        .filter(({ itensDoDia }) => itensDoDia.length > 0)
        .sort(
          (a, b) =>
            (a.c.horarioInicio ?? "99:99").localeCompare(b.c.horarioInicio ?? "99:99") ||
            a.c.nome.localeCompare(b.c.nome),
        )
        .map(({ c, itensDoDia }) => {
          const total = itensDoDia.length;
          const feitos = itensDoDia.filter((i) => i.status === "concluido").length;
          const completo = total > 0 && feitos === total;
          const limiteStr = limiteDaRotina(c);
          const atrasada =
            !completo &&
            !!limiteStr &&
            minutosNoCiclo(agora, c.corteDia) > minutosNoCiclo(limiteStr, c.corteDia);
          const status: StatusHistorico =
            iso > hojeISO
              ? "futura"
              : completo
                ? "completa"
                : atrasada
                  ? "incompleta"
                  : feitos === 0
                    ? "naoIniciada"
                    : "hoje";
          return {
            checklistId: c.id,
            nome: c.nome,
            responsavel: c.responsavel,
            turno: c.turnos.join(" · "),
            horario: c.horarioInicio ?? "",
            total,
            feitos,
            status,
          };
        });
    }

    dias.push({ iso, data: new Date(cursor), pausado, entradas });
    cursor.setDate(cursor.getDate() + 1);
  }

  return dias;
}

const fmtDataPdf = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

/** Pré-carrega uma logo do /public assim que o módulo é importado, para que
 *  já esteja pronta (img.complete) quando o usuário clicar em "Exportar PDF".
 *  Só roda no browser — este módulo também é importado durante o SSR. */
function preloadLogo(src: string): HTMLImageElement | null {
  if (typeof window === "undefined") return null;
  const img = new Image();
  img.src = src;
  return img;
}

const logoFelix = preloadLogo("/logo-felix.png");
const logoGtech = preloadLogo("/logo-gtech.png");

function logoPronta(img: HTMLImageElement | null): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0;
}

const COR_CABECALHO_DIA: [number, number, number] = [241, 245, 249];
const COR_TEXTO_DIA: [number, number, number] = [30, 41, 59];
const COR_TEXTO_APAGADO: [number, number, number] = [120, 120, 120];
const COLUNAS_TABELA = 5;

/**
 * Monta o PDF com as rotinas do período: funcionário, rotina, número de
 * atividades, quantidade concluída e quantidade incompleta de cada dia. Não
 * baixa o arquivo — quem chamar decide o que fazer com o documento (pré-
 * visualizar, baixar etc).
 *
 * Regras da tabela:
 * - dias que ainda não chegaram (futuros) não geram registro nenhum;
 * - dia marcado como sem expediente vira uma única linha "Dia desativado";
 * - rotina com dia de folga cadastrado nela (mas o dia em si com expediente
 *   normal) vira uma linha avisando que só aquela rotina foi desativada;
 * - cada dia começa com uma linha de cabeçalho (data), marcando a virada
 *   para quem estiver lendo a tabela.
 */
export function gerarHistoricoPdf(
  dias: DiaHistorico[],
  deISO: string,
  ateISO: string,
  checklists: Checklist[],
): jsPDF {
  const doc = new jsPDF();
  // Vira o nome sugerido pelo visor nativo do navegador ao baixar a partir
  // da pré-visualização (a aba aberta com o blob não tem nome de arquivo).
  doc.setProperties({ title: `historico-rotinas_${deISO}_a_${ateISO}` });

  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFontSize(14);
  doc.text("Histórico de rotinas", 14, 16);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(
    `Período: ${fmtDataPdf.format(dataDoIso(deISO))} a ${fmtDataPdf.format(dataDoIso(ateISO))}`,
    14,
    22,
  );

  // Canto oposto ao título — logo da Felix Matriz.
  if (logoPronta(logoFelix)) {
    const w = 18;
    const h = (w * logoFelix.naturalHeight) / logoFelix.naturalWidth;
    doc.addImage(logoFelix, "PNG", pageWidth - 14 - w, 8, w, h);
  }

  const hojeISO = isoDoDia(new Date());
  const ativas = checklists.filter((c) => c.ativo);

  const linhas: RowInput[] = [];
  for (const dia of dias) {
    if (dia.iso > hojeISO) continue; // dia ainda não chegou — sem registro

    const rotinasDesativadas = dia.pausado
      ? []
      : ativas.filter(
          (c) =>
            c.criadoEm <= dia.iso &&
            checklistPausadaNoDia(c, dia.data) &&
            !dia.entradas.some((e) => e.checklistId === c.id),
        );

    if (!dia.pausado && dia.entradas.length === 0 && rotinasDesativadas.length === 0) continue;

    linhas.push([
      {
        content: fmtDataPdf.format(dia.data),
        colSpan: COLUNAS_TABELA,
        styles: { fillColor: COR_CABECALHO_DIA, textColor: COR_TEXTO_DIA, fontStyle: "bold" },
      },
    ]);

    if (dia.pausado) {
      linhas.push([
        {
          content: "Dia desativado — sem expediente",
          colSpan: COLUNAS_TABELA,
          styles: { fontStyle: "italic", textColor: COR_TEXTO_APAGADO },
        },
      ]);
      continue;
    }

    for (const e of dia.entradas) {
      linhas.push([
        e.responsavel || "—",
        e.nome,
        e.total,
        e.feitos,
        Math.max(e.total - e.feitos, 0),
      ]);
    }

    for (const c of rotinasDesativadas) {
      linhas.push([
        c.responsavel || "—",
        { content: `${c.nome} — rotina desativada nesse dia`, styles: { fontStyle: "italic", textColor: COR_TEXTO_APAGADO } },
        { content: "—", styles: { textColor: COR_TEXTO_APAGADO } },
        { content: "—", styles: { textColor: COR_TEXTO_APAGADO } },
        { content: "—", styles: { textColor: COR_TEXTO_APAGADO } },
      ]);
    }
  }

  const gtechPronta = logoPronta(logoGtech);
  const larguraLogoGtech = 22;
  const alturaLogoGtech = gtechPronta
    ? (larguraLogoGtech * logoGtech.naturalHeight) / logoGtech.naturalWidth
    : 0;
  const espacoLogoGtech = 10 + alturaLogoGtech; // vão até a logo + respiro abaixo dela
  const margemInferiorPadrao = 10;

  autoTable(doc, {
    startY: 28,
    head: [["Funcionário", "Rotina", "Nº de atividades", "Concluídas", "Incompletas"]],
    body: linhas,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [220, 38, 38] },
    // Reserva o espaço da logo em toda página, inclusive a última — assim ela
    // nunca "sobra" sozinha numa página nova, sempre encaixa logo após a tabela.
    margin: { left: 14, right: 14, bottom: margemInferiorPadrao + espacoLogoGtech },
  });

  if (gtechPronta) {
    const finalY =
      (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 28;
    doc.addImage(
      logoGtech,
      "PNG",
      (pageWidth - larguraLogoGtech) / 2,
      finalY + 10,
      larguraLogoGtech,
      alturaLogoGtech,
    );
  }

  return doc;
}
