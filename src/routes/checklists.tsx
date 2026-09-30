import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarDays,
  CalendarOff,
  Camera,
  Check,
  ChevronDown,
  Clock,
  Eye,
  FileText,
  Filter,
  Loader2,
  Paperclip,
  Play,
  RotateCcw,
  Trash2,
  User,
  Users,
  Video,
  X,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EditarChecklistDialog, NovaChecklistDialog } from "@/components/checklist-form-dialog";
import { CalendarioChecklists } from "@/components/calendario-checklists";
import { CapturaCameraDialog } from "@/components/captura-camera";
import { SeletorDia } from "@/components/seletor-dia";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn, dataDoIso, FUSO_LOJA, isoDoDia } from "@/lib/utils";
import { useAuth } from "@/lib/auth-store";
import type { Anexo, ChecklistExecucaoRow } from "@/lib/supabase";
import { fetchExecucoes, HISTORICO_QUERY_KEY } from "@/lib/historico";
import { caminhoDoAnexo } from "@/lib/anexos-path";
import { anexosStorageService } from "@/lib/storage-service";
import { fetchNomesAdmin, NOMES_ADMIN_QUERY_KEY } from "@/lib/profiles";
import { DIAS_DESATIVADOS_QUERY_KEY, reativarDia, useHojeDesativado } from "@/lib/dias-desativados";
import {
  checklistPausadaNoDia,
  checklistRodaNoDia,
  checklistVigenteNoDia,
  descricaoAgenda,
  diaOperacionalChecklist,
  ehResponsavel,
  itemRodaNoDia,
  labelRecorrencia,
  limiteDaRotina,
  minutosNoCiclo,
  progresso,
  situacaoItem,
  turnos,
  turnoDoHorario,
  useGCheck,
  type Checklist,
  type ChecklistItem,
  type SituacaoItem,
  type Turno,
} from "@/lib/g-check-store";

/**
 * Estado exibido na checklist — mais granular que o do painel:
 *  - `nao_iniciada` — a rotina ainda não chegou no horário programado (fora da
 *    janela) e ninguém começou;
 *  - `pendente` — já está no horário, mas nenhum item foi feito (amarelo);
 *  - `em_andamento` — algum item já foi concluído, mas não todos (azul);
 *  - `atrasada` — passou do tempo limite sem concluir (vermelho);
 *  - `concluido` — todos os itens feitos (verde);
 *  - `desativada` — de folga só neste dia (diasPausados), a rotina continua
 *    ativa nos outros dias;
 *  - `inativa` — a rotina inteira foi desativada no cadastro (`c.ativo ===
 *    false`), então não faz sentido ela aparecer como pendente/atrasada/etc.
 */
export type EstadoVista =
  | "nao_iniciada"
  | "pendente"
  | "em_andamento"
  | "atrasada"
  | "concluido"
  | "desativada"
  | "inativa";

/**
 * "Ativada" não é um estado que uma rotina realmente assume — é um filtro
 * agregado: passa qualquer rotina que não esteja `inativa` nem `desativada`
 * (de folga hoje). Vive só no filtro (URL/UI), nunca é o retorno de
 * `estadoVista`/`estadoVistaCard`.
 */
export type EstadoFiltro = EstadoVista | "ativada";

const ESTADOS_VALIDOS: EstadoFiltro[] = [
  "nao_iniciada",
  "pendente",
  "em_andamento",
  "atrasada",
  "concluido",
  "desativada",
  "inativa",
  "ativada",
];

/** A rotina passa no filtro de Estado selecionado (vazio = passa tudo)? */
function passaFiltroEstado(estado: EstadoVista, selecionados: EstadoFiltro[]): boolean {
  if (selecionados.length === 0) return true;
  return selecionados.some((sel) =>
    sel === "ativada" ? estado !== "inativa" && estado !== "desativada" : sel === estado,
  );
}

/**
 * Filtro por ATIVIDADE — separado do filtro de Estado (que é da rotina):
 * quando ativo, não descarta a rotina inteira, só recorta a lista de itens
 * dela pros que passam no critério (mesmo mecanismo do filtro de horário —
 * ver `recortarHorario`). Hoje só tem uma opção; dá pra crescer aqui.
 */
export type FiltroTarefa = "concluida_atrasada";

const FILTROS_TAREFA_VALIDOS: FiltroTarefa[] = ["concluida_atrasada"];

const tarefaOptions: { id: FiltroTarefa; label: string }[] = [
  { id: "concluida_atrasada", label: "Concluídas atrasadas" },
];

/** A atividade passa no filtro de tarefa selecionado (vazio = passa tudo)? */
function passaFiltroTarefa(i: ChecklistItem, c: Checklist, filtros: FiltroTarefa[]): boolean {
  if (filtros.length === 0) return true;
  return filtros.some((f) => {
    if (f === "concluida_atrasada") {
      return i.status === "concluido" && situacaoItem(i, c) === "concluida_atrasada";
    }
    return false;
  });
}

/**
 * "Agora" a usar em `situacaoItem` conforme o dia em foco: dia passado — fim
 * do ciclo operacional daquele dia (qualquer prazo já venceu, senão um item
 * nunca concluído naquele dia ficaria "pendente" para sempre); dia futuro —
 * início do ciclo (nada atrasa antes de começar); hoje — o relógio real, ao
 * vivo. Com `c.corteDia` (turno que atravessa a meia-noite), o ciclo do dia
 * `dataFoco` só termina no corte do dia SEGUINTE (ex.: corte 08:00 → o dia
 * "vira" às 07:59 de amanhã, não às 23:59 de hoje) — ver `minutosNoCiclo`.
 */
function agoraParaSituacao(dataFoco: Date, c: Pick<Checklist, "corteDia">): Date {
  const cmp = isoDoDia(dataFoco).localeCompare(isoDoDia(new Date()));
  const [ch, cm] = (c.corteDia ?? "00:00").split(":").map(Number);
  if (cmp < 0) {
    const fim = new Date(dataFoco.getFullYear(), dataFoco.getMonth(), dataFoco.getDate());
    if (c.corteDia) {
      fim.setDate(fim.getDate() + 1);
      fim.setHours(ch ?? 0, (cm ?? 0) - 1, 59, 999);
    } else {
      fim.setHours(23, 59, 59);
    }
    return fim;
  }
  if (cmp > 0) {
    return new Date(dataFoco.getFullYear(), dataFoco.getMonth(), dataFoco.getDate(), ch ?? 0, cm ?? 0, 0);
  }
  return new Date();
}

/**
 * Estado ao vivo de uma rotina de hoje. A ordem das checagens define a
 * prioridade: inativa (desativada no cadastro) > desativada (de folga) >
 * concluída > atrasada > em andamento > pendente/não iniciada. Compara no
 * ciclo do `corteDia` (ver `minutosNoCiclo`) — sem isso, uma rotina noturna
 * (início 20:00, término 07:30) nasceria "atrasada" assim que o turno
 * começasse, porque 07:30 cru é "menor" que 20:00.
 */
function estadoVista(c: Checklist, agora: Date = new Date()): EstadoVista {
  if (!c.ativo) return "inativa";
  if (checklistPausadaNoDia(c, agora)) return "desativada";
  const { feitos, total } = progresso(c);
  if (total > 0 && feitos === total) return "concluido";
  const agoraCiclo = minutosNoCiclo(agora, c.corteDia);
  const limite = limiteDaRotina(c);
  if (limite && agoraCiclo > minutosNoCiclo(limite, c.corteDia)) return "atrasada";
  if (feitos > 0) return "em_andamento";
  // Nada feito e dentro do prazo: "pendente" quando o horário de início dos
  // itens já chegou (ou não há horário); senão ainda está fora da janela.
  return !c.horarioInicio || agoraCiclo >= minutosNoCiclo(c.horarioInicio, c.corteDia)
    ? "pendente"
    : "nao_iniciada";
}

/**
 * Estado do card conforme o dia em foco. Só o dia de hoje tem relógio ao vivo;
 * nos dias só-leitura (passado/futuro) "nada feito" é sempre "não iniciada".
 * `dataFoco` é o dia sendo visualizado — usado só para checar se a rotina
 * está de folga (diasPausados) naquele dia específico.
 */
function estadoVistaCard(c: Checklist, ehHoje: boolean, dataFoco: Date = new Date()): EstadoVista {
  if (!c.ativo) return "inativa";
  if (checklistPausadaNoDia(c, dataFoco)) return "desativada";
  if (ehHoje) return estadoVista(c);
  const { feitos, total } = progresso(c);
  if (total > 0 && feitos === total) return "concluido";
  return feitos > 0 ? "em_andamento" : "nao_iniciada";
}

/**
 * Posição da rotina na lista quanto à atividade — usada só para ordenar:
 * ativas primeiro (0), de folga só hoje depois (1), inativas no cadastro por
 * último (2). Não mexe no filtro, só na ordem de exibição.
 */
function rankInatividade(c: Checklist, dataFoco: Date): 0 | 1 | 2 {
  if (!c.ativo) return 2;
  if (checklistPausadaNoDia(c, dataFoco)) return 1;
  return 0;
}

/** Rótulo + classes do badge de cada estado da checklist. */
const ESTADO_VISTA_UI: Record<EstadoVista, { label: string; classe: string }> = {
  nao_iniciada: { label: "Não iniciada", classe: "bg-muted text-muted-foreground" },
  pendente: { label: "Pendente", classe: "bg-chart-4/20 text-chart-4" },
  em_andamento: { label: "Em andamento", classe: "bg-info/15 text-info" },
  atrasada: { label: "Atrasada", classe: "bg-destructive/15 text-destructive" },
  concluido: { label: "Concluído", classe: "bg-success/15 text-success" },
  desativada: { label: "De folga", classe: "bg-destructive/15 text-destructive" },
  inativa: { label: "Inativa", classe: "bg-muted text-muted-foreground" },
};

/**
 * Rótulo + classes do badge de situação de uma ATIVIDADE (item), pra revisão
 * no dia seguinte. "concluida_atrasada" fica verde de propósito — a tarefa foi
 * feita, então conta como concluída — só o rótulo/relógio avisam que passou
 * do prazo dela.
 */
const SITUACAO_ITEM_UI: Record<SituacaoItem, { label: string; classe: string; atraso?: boolean }> = {
  pendente: { label: "Pendente", classe: "bg-muted text-muted-foreground" },
  atrasada: { label: "Atrasada", classe: "bg-destructive/15 text-destructive" },
  concluida_no_prazo: { label: "Concluída", classe: "bg-success/15 text-success" },
  concluida_atrasada: {
    label: "Concluída atrasada",
    classe: "bg-success/15 text-success",
    atraso: true,
  },
};

/**
 * Monta um `Checklist` somente-leitura a partir do snapshot de um dia já fechado
 * (`checklist_execucoes`). Sem `tempoLimite` de propósito: fora de hoje não faz
 * sentido derivar "atrasada" pelo relógio atual. O snapshot já traz só os itens
 * que rodaram naquele dia, então cada item ganha uma recorrência "semanal" só
 * naquele dia da semana — assim os filtros por dia continuam mostrando todos.
 */
function checklistDeSnapshot(e: ChecklistExecucaoRow, vivo: Checklist | undefined): Checklist {
  const dowSnapshot = dataDoIso(e.data).getDay();
  const itens: ChecklistItem[] = (e.itens ?? []).map((it, idx) => {
    const horarioInicio = it.horario_inicio ? it.horario_inicio.slice(0, 5) : null;
    return {
      id: `${e.checklist_id}-snap-${idx}`,
      titulo: it.titulo,
      status: it.status === "concluido" ? "concluido" : "pendente",
      tipoTarefa: it.tipo_tarefa ?? "checklist",
      respostaOpcoes: it.resposta_opcoes ?? [],
      resposta: it.resposta ?? null,
      justificativa: it.justificativa ?? null,
      turno: it.turno ?? turnoDoHorario(horarioInicio),
      horarioInicio,
      horarioTermino: it.horario_termino ? it.horario_termino.slice(0, 5) : null,
      minAnexos: it.min_anexos ?? 0,
      maxAnexos: it.max_anexos ?? null,
      anexos: it.anexos ?? [],
      concluidoEm: it.concluido_em ?? null,
      recorrencia: "semanal" as const,
      diasSemana: [dowSnapshot],
      inicio: null,
    };
  });
  return {
    id: e.checklist_id,
    nome: e.nome,
    responsavel: vivo?.responsavel ?? e.itens[0]?.responsavel ?? "",
    ativo: vivo?.ativo ?? true,
    reabreAutomatico: vivo?.reabreAutomatico ?? false,
    ...(vivo?.reabreIntervaloMin ? { reabreIntervaloMin: vivo.reabreIntervaloMin } : {}),
    ...descricaoAgenda(itens, vivo?.corteDia),
    ...(vivo?.corteDia ? { corteDia: vivo.corteDia } : {}),
    criadoEm: vivo?.criadoEm ?? e.data,
    diasPausados: vivo?.diasPausados ?? [],
    itens,
  };
}

/** Cópia da rotina com todo item "pendente" — usada em dias que ainda não chegaram. */
function checklistPendente(c: Checklist): Checklist {
  return {
    ...c,
    // Dia que ainda não chegou: sem status e sem os anexos do dia de hoje.
    itens: c.itens.map((i) => ({
      ...i,
      anexos: [],
      status: "pendente" as const,
      resposta: null,
      justificativa: null,
      concluidoEm: null,
    })),
  };
}

/**
 * Filtros (e o card a destacar) vêm pela URL — assim o dashboard pode linkar
 * direto para "/checklists" já com um recorte aplicado, e o estado do filtro
 * fica compartilhável/versionável pelo histórico do navegador.
 */
export interface ChecklistSearch {
  estados?: EstadoFiltro[] | undefined;
  /** Filtro por atividade (ex.: concluídas atrasadas) — recorta os itens de
   *  cada rotina, não descarta a rotina inteira. Ver `passaFiltroTarefa`. */
  tarefas?: FiltroTarefa[] | undefined;
  turnos?: Turno[] | undefined;
  /**
   * Faixa de horário de início ("HH:MM"): mantém rotinas com ao menos um item
   * começando dentro do intervalo. Qualquer um dos limites pode vir sozinho.
   */
  horarioDe?: string | undefined;
  horarioAte?: string | undefined;
  /** Nomes de responsáveis: mantém as rotinas atribuídas a essas pessoas. */
  funcionarios?: string[] | undefined;
  /** id da checklist que deve abrir expandida e receber scroll ao entrar na página. */
  checklist?: string | undefined;
  /**
   * Seletor de dia: ISO "yyyy-MM-dd" filtra pelas atividades daquele dia;
   * "todas" mostra todas as atividades de todas as rotinas (somente leitura);
   * "quinzenal"/"mensal" mostram só as atividades daquela recorrência, de todas
   * as rotinas, sem recorte por dia (somente leitura).
   */
  dia?: string | undefined;
  /** "calendario" troca o conteúdo do <main> pela tela de calendário (header/sidebar seguem). */
  vista?: "calendario" | undefined;
  /**
   * Só tem efeito pra quem enxerga todas as rotinas (admin/'consultar_checklists_outros'/
   * 'marcar_checklists_outros'): "minhas" troca a lista completa pelo mesmo
   * formato enxuto do funcionário comum (rotina já aberta, só as atividades
   * de que é responsável).
   */
  secao?: "minhas" | undefined;
}

export const Route = createFileRoute("/checklists")({
  head: () => ({
    meta: [
      { title: "Checklists de rotina — G-check" },
      {
        name: "description",
        content:
          "Abra e conclua rotinas de supermercado: abertura, reposição de gôndolas, validade, limpeza e fechamento.",
      },
      { property: "og:title", content: "Checklists de rotina — G-check" },
      {
        property: "og:description",
        content: "Acompanhe item por item as rotinas operacionais da sua loja.",
      },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): ChecklistSearch => {
    const rawEstados = search["estados"];
    const rawTarefas = search["tarefas"];
    const rawTurnos = search["turnos"];
    const rawHorarioDe = search["horarioDe"];
    const rawHorarioAte = search["horarioAte"];
    const rawFuncionarios = search["funcionarios"];
    const rawChecklist = search["checklist"];
    const rawDia = search["dia"];
    const rawVista = search["vista"];
    const rawSecao = search["secao"];

    const estados = Array.isArray(rawEstados)
      ? rawEstados.filter((e): e is EstadoFiltro => ESTADOS_VALIDOS.includes(e as EstadoFiltro))
      : undefined;
    const tarefasFiltro = Array.isArray(rawTarefas)
      ? rawTarefas.filter((t): t is FiltroTarefa =>
          FILTROS_TAREFA_VALIDOS.includes(t as FiltroTarefa),
        )
      : undefined;
    const turnosSearch = Array.isArray(rawTurnos)
      ? rawTurnos.filter((t): t is Turno => (turnos as readonly string[]).includes(t as string))
      : undefined;
    const ehHHMM = (v: unknown): v is string => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);
    const horarioDe = ehHHMM(rawHorarioDe) ? rawHorarioDe : undefined;
    const horarioAte = ehHHMM(rawHorarioAte) ? rawHorarioAte : undefined;
    // Funcionários é texto livre (vem do cadastro): só filtramos por tipo.
    const funcionarios = Array.isArray(rawFuncionarios)
      ? rawFuncionarios.filter((f): f is string => typeof f === "string" && f.length > 0)
      : undefined;
    const checklist = typeof rawChecklist === "string" ? rawChecklist : undefined;
    const dia =
      rawDia === "todas" || rawDia === "quinzenal" || rawDia === "mensal"
        ? rawDia
        : typeof rawDia === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDia)
          ? rawDia
          : undefined;
    const vista = rawVista === "calendario" ? "calendario" : undefined;
    const secao = rawSecao === "minhas" ? "minhas" : undefined;

    return {
      ...(estados && estados.length ? { estados } : {}),
      ...(tarefasFiltro && tarefasFiltro.length ? { tarefas: tarefasFiltro } : {}),
      ...(turnosSearch && turnosSearch.length ? { turnos: turnosSearch } : {}),
      ...(horarioDe ? { horarioDe } : {}),
      ...(horarioAte ? { horarioAte } : {}),
      ...(funcionarios && funcionarios.length ? { funcionarios } : {}),
      ...(checklist ? { checklist } : {}),
      ...(dia ? { dia } : {}),
      ...(vista ? { vista } : {}),
      ...(secao ? { secao } : {}),
    };
  },
  component: ChecklistsPage,
});

const estadoOptions: { id: EstadoFiltro; label: string }[] = [
  { id: "ativada", label: "Ativadas" },
  { id: "nao_iniciada", label: "Não iniciadas" },
  { id: "pendente", label: "Pendentes" },
  { id: "em_andamento", label: "Em andamento" },
  { id: "atrasada", label: "Atrasadas" },
  { id: "concluido", label: "Concluídos" },
  { id: "desativada", label: "De folga" },
  { id: "inativa", label: "Inativas" },
];

const turnoOptions: { id: Turno; label: string }[] = turnos.map((t) => ({ id: t, label: t }));

/**
 * Botão de filtros: abre um popover com as opções agrupadas (Estado / Turno /
 * Funcionário) onde cada clique já liga/desliga aquele filtro (multi-seleção,
 * sem passo extra de "aplicar"). Funcionário sai dos próprios dados das
 * rotinas, então a busca no topo ajuda quando a lista cresce. As opções ativas
 * aparecem como badges removíveis ao lado, cada uma com seu X.
 */
function FiltrosChecklist({
  estadosSelecionados,
  tarefasSelecionadas,
  turnosSelecionados,
  horarioDe,
  horarioAte,
  funcionariosSelecionados,
  horariosDisponiveis,
  funcionariosDisponiveis,
  onToggleEstado,
  onToggleTarefa,
  onToggleTurno,
  onChangeHorario,
  onToggleFuncionario,
  onLimpar,
}: {
  estadosSelecionados: EstadoFiltro[];
  tarefasSelecionadas: FiltroTarefa[];
  turnosSelecionados: Turno[];
  horarioDe: string | undefined;
  horarioAte: string | undefined;
  funcionariosSelecionados: string[];
  /** Horários de início presentes nos itens — viram sugestões nos campos De/Até. */
  horariosDisponiveis: string[];
  funcionariosDisponiveis: string[];
  onToggleEstado: (id: EstadoFiltro) => void;
  onToggleTarefa: (id: FiltroTarefa) => void;
  onToggleTurno: (id: Turno) => void;
  onChangeHorario: (patch: { de?: string | undefined; ate?: string | undefined }) => void;
  onToggleFuncionario: (id: string) => void;
  onLimpar: () => void;
}) {
  const temHorario = !!horarioDe || !!horarioAte;
  const total =
    estadosSelecionados.length +
    tarefasSelecionadas.length +
    turnosSelecionados.length +
    (temHorario ? 1 : 0) +
    funcionariosSelecionados.length;

  // Os campos "De"/"Até" são digitados localmente e só entram na URL quando o
  // campo perde o foco (ou no Enter). Se cada tecla chamasse onChangeHorario, o
  // navigate() re-renderiza e devolve o valor controlado no meio da digitação —
  // por isso "11:30" virava "11:03"/"11:00".
  const [horDe, setHorDe] = React.useState(horarioDe ?? "");
  const [horAte, setHorAte] = React.useState(horarioAte ?? "");
  React.useEffect(() => setHorDe(horarioDe ?? ""), [horarioDe]);
  React.useEffect(() => setHorAte(horarioAte ?? ""), [horarioAte]);
  const comitarDe = () => {
    if ((horDe || undefined) !== horarioDe) onChangeHorario({ de: horDe || undefined });
  };
  const comitarAte = () => {
    if ((horAte || undefined) !== horarioAte) onChangeHorario({ ate: horAte || undefined });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Filter className="size-4" />
            Filtros
            {total > 0 && (
              <Badge className="h-5 min-w-5 justify-center rounded-full border-transparent bg-primary px-1 text-primary-foreground">
                {total}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <Command>
            <CommandInput placeholder="Buscar filtro…" />
            <CommandList>
              <CommandEmpty>Nada encontrado.</CommandEmpty>
              <CommandGroup heading="Estado">
                {estadoOptions.map((o) => {
                  const ativo = estadosSelecionados.includes(o.id);
                  return (
                    <CommandItem
                      key={o.id}
                      onSelect={() => onToggleEstado(o.id)}
                      className="justify-between"
                    >
                      {o.label}
                      {ativo && <Check className="size-4 text-primary" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              <CommandSeparator />
              {/* Filtro por ATIVIDADE, não por rotina: em vez de esconder a
                  rotina inteira, recorta pra só as atividades que batem
                  (ver passaFiltroTarefa/recortarTarefa). */}
              <CommandGroup heading="Tarefa">
                {tarefaOptions.map((o) => {
                  const ativo = tarefasSelecionadas.includes(o.id);
                  return (
                    <CommandItem
                      key={o.id}
                      onSelect={() => onToggleTarefa(o.id)}
                      className="justify-between"
                    >
                      {o.label}
                      {ativo && <Check className="size-4 text-primary" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Turno">
                {turnoOptions.map((o) => {
                  const ativo = turnosSelecionados.includes(o.id);
                  return (
                    <CommandItem
                      key={o.id}
                      onSelect={() => onToggleTurno(o.id)}
                      className="justify-between"
                    >
                      {o.label}
                      {ativo && <Check className="size-4 text-primary" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {funcionariosDisponiveis.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Funcionário">
                    {funcionariosDisponiveis.map((f) => {
                      const ativo = funcionariosSelecionados.includes(f);
                      return (
                        <CommandItem
                          key={f}
                          value={`funcionario ${f}`}
                          onSelect={() => onToggleFuncionario(f)}
                          className="justify-between"
                        >
                          <span className="truncate">{f}</span>
                          {ativo && <Check className="size-4 shrink-0 text-primary" />}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>

          <div className="border-t border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">Horário de início</p>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="time"
                aria-label="Horário inicial"
                value={horDe}
                list="checklist-horarios"
                onChange={(e) => setHorDe(e.target.value)}
                onBlur={comitarDe}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <span className="text-xs text-muted-foreground">até</span>
              <input
                type="time"
                aria-label="Horário final"
                value={horAte}
                list="checklist-horarios"
                onChange={(e) => setHorAte(e.target.value)}
                onBlur={comitarAte}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            {horariosDisponiveis.length > 0 && (
              <datalist id="checklist-horarios">
                {horariosDisponiveis.map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
            )}
            {temHorario && (
              <button
                onClick={() => onChangeHorario({ de: undefined, ate: undefined })}
                className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Limpar horário
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {estadosSelecionados.map((id) => (
        <Badge key={id} variant="secondary" className="gap-1 py-1 pl-2.5 pr-1.5 font-medium">
          {estadoOptions.find((o) => o.id === id)?.label}
          <button
            onClick={() => onToggleEstado(id)}
            aria-label={`Remover filtro ${estadoOptions.find((o) => o.id === id)?.label ?? id}`}
            className="rounded-full p-0.5 hover:bg-foreground/10"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      {tarefasSelecionadas.map((id) => (
        <Badge key={id} variant="secondary" className="gap-1 py-1 pl-2.5 pr-1.5 font-medium">
          {tarefaOptions.find((o) => o.id === id)?.label}
          <button
            onClick={() => onToggleTarefa(id)}
            aria-label={`Remover filtro ${tarefaOptions.find((o) => o.id === id)?.label ?? id}`}
            className="rounded-full p-0.5 hover:bg-foreground/10"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      {turnosSelecionados.map((t) => (
        <Badge key={t} variant="secondary" className="gap-1 py-1 pl-2.5 pr-1.5 font-medium">
          {t}
          <button
            onClick={() => onToggleTurno(t)}
            aria-label={`Remover filtro ${t}`}
            className="rounded-full p-0.5 hover:bg-foreground/10"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      {temHorario && (
        <Badge variant="secondary" className="gap-1 py-1 pl-2.5 pr-1.5 font-medium">
          {horarioDe && horarioAte
            ? `${horarioDe}–${horarioAte}`
            : horarioDe
              ? `a partir de ${horarioDe}`
              : `até ${horarioAte}`}
          <button
            onClick={() => onChangeHorario({ de: undefined, ate: undefined })}
            aria-label="Remover filtro de horário"
            className="rounded-full p-0.5 hover:bg-foreground/10"
          >
            <X className="size-3" />
          </button>
        </Badge>
      )}
      {funcionariosSelecionados.map((f) => (
        <Badge key={f} variant="secondary" className="gap-1 py-1 pl-2.5 pr-1.5 font-medium">
          {f}
          <button
            onClick={() => onToggleFuncionario(f)}
            aria-label={`Remover filtro ${f}`}
            className="rounded-full p-0.5 hover:bg-foreground/10"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      {total > 0 && (
        <button
          onClick={onLimpar}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Limpar tudo
        </button>
      )}
    </div>
  );
}

function EstadoBadge({
  c,
  ehHoje = true,
  dataFoco = new Date(),
}: {
  c: Checklist;
  ehHoje?: boolean;
  dataFoco?: Date;
}) {
  const ui = ESTADO_VISTA_UI[estadoVistaCard(c, ehHoje, dataFoco)];
  return (
    <Badge variant="outline" className={cn("border-transparent font-medium", ui.classe)}>
      {ui.label}
    </Badge>
  );
}

/**
 * Badge de situação de uma atividade (pendente/atrasada/concluída/concluída
 * atrasada — ver `situacaoItem`). O relógio some quando a tarefa está em dia;
 * aparece só pra marcar atraso (pendente vencida ou concluída fora do prazo).
 */
const fmtHoraConclusao = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: FUSO_LOJA,
});

function SituacaoItemBadge({
  item,
  checklist,
  agora,
}: {
  item: ChecklistItem;
  checklist: Checklist;
  agora?: Date;
}) {
  const ui = SITUACAO_ITEM_UI[situacaoItem(item, checklist, agora)];
  const horaConclusao = item.status === "concluido" && item.concluidoEm
    ? fmtHoraConclusao.format(new Date(item.concluidoEm))
    : null;
  return (
    <Badge variant="outline" className={cn("gap-1 border-transparent font-medium", ui.classe)}>
      {ui.atraso && <Clock className="size-3" />}
      {ui.label}
      {horaConclusao && <span className="font-normal opacity-80">· {horaConclusao}</span>}
    </Badge>
  );
}

/**
 * Badge de uma rotina de um dia já fechado: não há "em andamento" — ou ela foi
 * concluída (verde) ou ficou incompleta (vermelho), com o mesmo ponto colorido
 * usado no Histórico.
 */
function BadgeDiaFechado({ c }: { c: Checklist }) {
  const { feitos, total } = progresso(c);
  const completa = total > 0 && feitos === total;
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-transparent font-medium",
        completa ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
      )}
    >
      <span className={cn("size-1.5 rounded-full", completa ? "bg-success" : "bg-destructive")} />
      {completa ? "Concluída" : "Incompleta"}
    </Badge>
  );
}

function ExcluirChecklistButton({ c }: { c: Checklist }) {
  const { excluirChecklist } = useGCheck();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={`Excluir ${c.nome}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir “{c.nome}”?</AlertDialogTitle>
          <AlertDialogDescription>
            A checklist e seus {c.itens.length} {c.itens.length === 1 ? "item" : "itens"} serão
            removidos. Não dá para desfazer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => excluirChecklist(c.id)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Excluir
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Botões de opção de uma atividade "enquete". Ficam do lado oposto ao check
 * (que abre à esquerda da linha). Só o responsável (ou admin) escolhe; a
 * conclusão exige uma opção marcada (trava no store e no trigger do banco).
 */
function EnqueteOpcoes({
  checklistId,
  item,
  podeEditar,
  className,
}: {
  checklistId: string;
  item: ChecklistItem;
  podeEditar: boolean;
  className?: string;
}) {
  const { responderEnquete } = useGCheck();
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {item.respostaOpcoes.map((opcao) => {
        const ativo = item.resposta === opcao;
        return (
          <button
            key={opcao}
            type="button"
            disabled={!podeEditar}
            aria-pressed={ativo}
            onClick={() => podeEditar && responderEnquete(checklistId, item.id, opcao)}
            className={cn(
              "whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              ativo
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input text-muted-foreground hover:border-primary hover:text-foreground",
              !podeEditar && "cursor-not-allowed opacity-60",
            )}
          >
            {opcao}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Barra de justificativa/observação de uma atividade "enquete": o responsável
 * explica o motivo da resposta — vale tanto para as positivas quanto para as
 * negativas. Grava no `onBlur` (sem botão extra). Obrigatória pra concluir a
 * atividade — ver `justificativaPendente` em ChecklistCard/TarefaRow.
 */
function JustificativaCampo({
  checklistId,
  item,
  podeEditar,
  className,
}: {
  checklistId: string;
  item: ChecklistItem;
  podeEditar: boolean;
  className?: string;
}) {
  const { justificarItem } = useGCheck();
  const [texto, setTexto] = React.useState(item.justificativa ?? "");
  React.useEffect(() => {
    setTexto(item.justificativa ?? "");
  }, [item.justificativa]);

  return (
    <Textarea
      rows={2}
      value={texto}
      disabled={!podeEditar}
      placeholder="Justificativa / observação (o motivo da resposta) — obrigatória"
      onChange={(e) => setTexto(e.target.value)}
      onBlur={() => {
        if (texto !== (item.justificativa ?? "")) justificarItem(checklistId, item.id, texto);
      }}
      className={cn("text-sm", className)}
    />
  );
}

/** TTL das URLs assinadas na StorageService — cache um pouco mais curto pra
 *  sempre reassinar bem antes de expirar. */
const ANEXOS_SIGNED_URL_STALE_MS = 50 * 60 * 1000;

/** Resolve, em lote, uma URL assinada (temporária) para cada anexo de uma
 *  lista — o bucket é privado, então `a.url` (a URL pública salva no jsonb)
 *  não resolve mais sozinha; ela só serve pra derivar o `storage_path`. */
function useAnexosSignedUrls(anexos: Anexo[]) {
  const caminhos = React.useMemo(
    () =>
      Array.from(new Set(anexos.map((a) => caminhoDoAnexo(a.url)).filter((c): c is string => !!c))),
    [anexos],
  );
  return useQuery({
    queryKey: ["anexos-signed-urls", ...caminhos],
    queryFn: async () => {
      const porCaminho = await anexosStorageService.getSignedUrls(caminhos);
      // Reindexa por `url` pública (chave usada pelo resto do componente).
      const porUrl: Record<string, string> = {};
      for (const a of anexos) {
        const caminho = caminhoDoAnexo(a.url);
        if (caminho && porCaminho[caminho]) porUrl[a.url] = porCaminho[caminho];
      }
      return porUrl;
    },
    enabled: caminhos.length > 0,
    staleTime: ANEXOS_SIGNED_URL_STALE_MS,
    gcTime: ANEXOS_SIGNED_URL_STALE_MS + 10 * 60 * 1000,
  });
}

/**
 * Anexos de comprovação de um item (foto, vídeo ou documento — vários por item).
 * Quando `podeEditar`, mostra o botão de adicionar e o "x" de cada anexo; caso
 * contrário fica só com as miniaturas/chips clicáveis (dia fechado / leitura).
 * A trava de "não conclui sem os anexos mínimos" mora no store (toggleItem) e no
 * banco (trigger).
 */
function AnexosItem({
  checklistId,
  item,
  podeEditar,
}: {
  checklistId: string;
  item: ChecklistItem;
  podeEditar: boolean;
}) {
  const { anexarArquivo, removerAnexo } = useGCheck();
  const [modoCaptura, setModoCaptura] = React.useState<"foto" | "video" | null>(null);
  const [enviando, setEnviando] = React.useState(false);
  const [fotoAmpliada, setFotoAmpliada] = React.useState<{ url: string; nome: string } | null>(
    null,
  );
  const { data: urlsAssinadas } = useAnexosSignedUrls(item.anexos);

  async function enviarArquivo(arquivo: File) {
    setEnviando(true);
    try {
      await anexarArquivo(checklistId, item.id, arquivo);
    } catch {
      /* erro já sinalizado por toast no store */
    } finally {
      setEnviando(false);
    }
  }

  async function aoRemover(url: string) {
    setEnviando(true);
    try {
      await removerAnexo(checklistId, item.id, url);
    } catch {
      /* toast no store */
    } finally {
      setEnviando(false);
    }
  }

  const faltam = Math.max(0, item.minAnexos - item.anexos.length);

  return (
    <div className="mt-2 flex flex-col gap-2">
      {(item.anexos.length > 0 || item.minAnexos > 0 || podeEditar) && (
        <div className="flex flex-wrap items-center gap-2">
          {item.anexos.map((a) => {
            const ehImagem = a.tipo.startsWith("image/");
            const ehVideo = a.tipo.startsWith("video/");
            const urlAssinada = urlsAssinadas?.[a.url];
            return (
              <span key={a.url} className="group relative inline-flex shrink-0">
                {ehImagem ? (
                  <button
                    type="button"
                    disabled={!urlAssinada}
                    onClick={() => urlAssinada && setFotoAmpliada({ url: urlAssinada, nome: a.nome })}
                  >
                    {urlAssinada ? (
                      <img
                        src={urlAssinada}
                        alt={a.nome}
                        className="size-14 rounded-lg border border-border object-cover"
                      />
                    ) : (
                      <span className="flex size-14 items-center justify-center rounded-lg border border-border bg-muted">
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      </span>
                    )}
                  </button>
                ) : (
                  <a
                    href={urlAssinada}
                    target="_blank"
                    rel="noreferrer"
                    aria-disabled={!urlAssinada}
                    onClick={(e) => {
                      if (!urlAssinada) e.preventDefault();
                    }}
                    className="inline-flex max-w-[10rem] items-center gap-1.5 rounded-lg border border-border bg-muted px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground aria-disabled:opacity-50"
                  >
                    {ehVideo ? (
                      <Play className="size-3.5 shrink-0" />
                    ) : (
                      <FileText className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{a.nome}</span>
                  </a>
                )}
                {podeEditar && (
                  <button
                    type="button"
                    onClick={() => aoRemover(a.url)}
                    disabled={enviando}
                    aria-label={`Remover ${a.nome}`}
                    className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground shadow-sm hover:text-destructive disabled:opacity-50"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </span>
            );
          })}

          {podeEditar && (
            <>
              {/* Captura direto na página (getUserMedia/MediaRecorder), sem
                  abrir o app de câmera do celular: um `<input capture>` joga
                  a aba pra segundo plano, e em celulares com pouca RAM (ou
                  gravações mais longas) o sistema às vezes descarta a aba
                  nesse meio tempo, perdendo o arquivo sem erro nenhum. */}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={enviando}
                onClick={() => setModoCaptura("foto")}
              >
                {enviando ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Camera className="size-3.5" />
                )}
                Foto
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={enviando}
                onClick={() => setModoCaptura("video")}
              >
                {enviando ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Video className="size-3.5" />
                )}
                Vídeo
              </Button>
              {enviando && (
                <span
                  role="status"
                  aria-live="polite"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-info"
                >
                  <Loader2 className="size-3.5 animate-spin" />
                  Enviando, aguarde…
                </span>
              )}
              {modoCaptura && (
                <CapturaCameraDialog
                  open
                  modo={modoCaptura}
                  onOpenChange={(v) => !v && setModoCaptura(null)}
                  onCapturar={(arquivo) => {
                    setModoCaptura(null);
                    enviarArquivo(arquivo);
                  }}
                />
              )}
            </>
          )}

          {!podeEditar && item.anexos.length === 0 && (
            <span className="text-xs text-muted-foreground">Sem anexos</span>
          )}
        </div>
      )}

      {item.minAnexos > 0 && (
        <span
          className={cn(
            "text-xs",
            faltam > 0 ? "font-medium text-chart-4" : "text-muted-foreground",
          )}
        >
          {item.anexos.length}/{item.minAnexos} anexos
          {faltam > 0 && ` · faltam ${faltam}`}
        </span>
      )}

      <Dialog open={!!fotoAmpliada} onOpenChange={(v) => !v && setFotoAmpliada(null)}>
        <DialogContent
          showCloseButton={false}
          className="max-w-3xl border-none bg-transparent p-0 shadow-none"
        >
          <DialogTitle className="sr-only">{fotoAmpliada?.nome ?? "Foto do anexo"}</DialogTitle>
          {fotoAmpliada && (
            <img
              src={fotoAmpliada.url}
              alt={fotoAmpliada.nome}
              className="max-h-[85vh] w-full rounded-lg object-contain"
            />
          )}
          <DialogClose className="absolute -right-2 -top-2 rounded-full border border-border bg-background p-1.5 text-foreground shadow-sm hover:opacity-80">
            <X className="size-4" />
            <span className="sr-only">Fechar</span>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChecklistCard({
  c,
  destacar = false,
  travado = false,
  somenteLeitura = false,
  diaFechado = false,
  dataFoco = new Date(),
}: {
  c: Checklist;
  destacar?: boolean | undefined;
  /** Dia pausado (feriado): itens não podem ser marcados/concluídos/reabertos. */
  travado?: boolean | undefined;
  /** Dia diferente de hoje: a card abre para ver as tarefas, mas nada pode ser marcado. */
  somenteLeitura?: boolean | undefined;
  /** Dia passado já encerrado: o badge de estado vira "Concluída"/"Incompleta". */
  diaFechado?: boolean | undefined;
  /** Dia sendo visualizado — usado para saber se a ROTINA está de folga nele. */
  dataFoco?: Date | undefined;
}) {
  const { toggleItem, concluirTodos, reabrir, removerDiaPausado } = useGCheck();
  const { isAdmin, temAcesso, profile } = useAuth();
  // Editar/excluir a rotina e mexer na folga do dia exige 'criar_checklist'
  // (mesmo atalho que o admin tem no banco — ver trigger
  // checklist_items_restrict_funcionario_update).
  const podeGerir = isAdmin || temAcesso("criar_checklist");
  // Marcar item de rotina de que não é responsável: quem gerencia a checklist
  // já pode; 'marcar_checklists_outros' libera só a marcação, sem dar acesso
  // a criar/editar/excluir a estrutura da checklist.
  const podeMarcarOutros = podeGerir || temAcesso("marcar_checklists_outros");
  // Reabrir um item já concluído é uma permissão à parte (reabrir_rotina) —
  // quem só administra a rotina (podeGerir) já passa direto na trigger.
  const podeReabrirItem = podeGerir || temAcesso("reabrir_rotina");
  const [aberto, setAberto] = React.useState(destacar);
  const sectionRef = React.useRef<HTMLElement>(null);
  const p = progresso(c);
  // Rotina de folga neste dia (cadastro dela, não o feriado geral da loja):
  // fica visível, mas bloqueada e com aviso — não desaparece da lista.
  const pausada = checklistPausadaNoDia(c, dataFoco);
  // Dia pausado (feriado) ou rotina de folga: a rotina não abre nem aceita
  // marcação — o card fica só com o cabeçalho. "somenteLeitura" (outro dia)
  // ainda abre.
  const bloqueado = travado || pausada;
  const expandido = aberto && !bloqueado;

  // Chegou pela URL "?checklist=<id>" (link de uma pendência no dashboard):
  // rola até a card e a deixa expandida.
  React.useEffect(() => {
    if (destacar) sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [destacar]);

  return (
    <section
      ref={sectionRef}
      className={cn(
        "scroll-mt-24 rounded-2xl border shadow-sm transition-shadow",
        pausada ? "border-destructive/30 bg-destructive/5" : "border-border bg-card",
        !pausada && (!c.ativo || bloqueado) && "opacity-70",
        destacar && "ring-2 ring-primary/60",
      )}
    >
      <div className="flex items-start gap-2 p-5">
        <button
          onClick={() => setAberto((v) => !v)}
          disabled={bloqueado}
          className="flex min-w-0 flex-1 flex-col gap-4 text-left disabled:cursor-not-allowed"
          aria-expanded={expandido}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight">{c.nome}</h2>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {c.responsavel && (
                  <span className="inline-flex items-center gap-1">
                    <User className="size-3.5" /> {c.responsavel}
                  </span>
                )}
                {(c.turnos.length > 0 || c.horarioInicio) && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3.5" />{" "}
                    {[
                      c.turnos.join(" · "),
                      c.horarioInicio &&
                        (c.horarioTermino
                          ? `${c.horarioInicio}–${c.horarioTermino}`
                          : c.horarioInicio),
                      c.tempoLimite && `até ${c.tempoLimite}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="size-3.5" /> {c.itens.length}{" "}
                  {c.itens.length === 1 ? "atividade" : "atividades"}
                </span>
                {c.reabreAutomatico && c.reabreIntervaloMin && (
                  <span className="inline-flex items-center gap-1">
                    <RotateCcw className="size-3.5" /> reabre a cada {c.reabreIntervaloMin} min
                  </span>
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {somenteLeitura && !bloqueado && (
                <Badge
                  variant="outline"
                  className="gap-1 border-transparent bg-muted text-muted-foreground"
                >
                  <Eye className="size-3" />
                  Leitura
                </Badge>
              )}
              {pausada ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-transparent bg-destructive/15 text-destructive"
                >
                  <CalendarOff className="size-3" />
                  De folga
                </Badge>
              ) : bloqueado ? (
                <Badge
                  variant="outline"
                  className="border-transparent bg-muted text-muted-foreground"
                >
                  Desativada hoje
                </Badge>
              ) : diaFechado ? (
                <BadgeDiaFechado c={c} />
              ) : (
                <EstadoBadge c={c} ehHoje={!somenteLeitura} dataFoco={dataFoco} />
              )}
              {!bloqueado && (
                <ChevronDown
                  className={cn(
                    "size-4 text-muted-foreground transition-transform",
                    expandido && "rotate-180",
                  )}
                />
              )}
            </div>
          </div>
          {pausada ? (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <CalendarOff className="size-3.5 shrink-0" />
              Rotina de folga neste dia — as atividades continuam cadastradas (nada foi apagado), só
              não contam como pendência nem podem ser marcadas hoje.
              {podeGerir && " Use o botão de reabrir ao lado para remover a folga deste dia."}
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {p.feitos} de {p.total} itens concluídos
                </span>
                <span className="font-medium text-foreground">{p.pct}%</span>
              </div>
              <Progress value={p.pct} className="h-1.5" />
            </div>
          )}
        </button>
        {podeGerir && (
          <div className="flex shrink-0 items-center gap-0.5">
            {pausada && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 shrink-0 text-destructive hover:text-destructive"
                aria-label="Remover folga deste dia"
                title="Remover folga deste dia"
                onClick={() => removerDiaPausado(c.id, isoDoDia(dataFoco))}
              >
                <RotateCcw className="size-4" />
              </Button>
            )}
            <EditarChecklistDialog checklist={c} />
            <ExcluirChecklistButton c={c} />
          </div>
        )}
      </div>

      {expandido && (
        <div className="border-t border-border p-5 pt-4">
          <ul className="divide-y divide-border">
            {c.itens.map((i) => {
              const feito = i.status === "concluido";
              // Quem gerencia a rotina ou tem 'marcar_checklists_outros' marca
              // qualquer item; funcionário comum só os da rotina de que é
              // responsável (por nome, ver ehResponsavel em g-check-store.tsx).
              // Reabrir um item concluído exige também 'reabrir_rotina'.
              // Reforçado no banco pelas migrations
              // 20260908120000_responsavel_por_rotina.sql e
              // 20260908160000_cargos_permissoes.sql.
              const podeMarcar =
                !bloqueado &&
                !somenteLeitura &&
                (podeMarcarOutros || ehResponsavel(c, profile?.nome)) &&
                (feito ? podeReabrirItem : true);
              // Item que ainda não tem os anexos mínimos: não dá pra concluir (só reabrir).
              const anexosPendentes = i.anexos.length < i.minAnexos && !feito;
              // Enquete sem opção escolhida: idem, trava a conclusão.
              const respostaPendente = i.tipoTarefa === "enquete" && !i.resposta && !feito;
              // Enquete sem justificativa preenchida: idem — a justificativa é
              // obrigatória pra concluir.
              const justificativaPendente =
                i.tipoTarefa === "enquete" && !i.justificativa?.trim() && !feito;
              const travaConclusao = anexosPendentes || respostaPendente || justificativaPendente;
              // Horário/turno definidos para a atividade (turno cai do horário
              // quando não foi escolhido à mão).
              const turnoItem = i.turno ?? turnoDoHorario(i.horarioInicio);
              const faixaHoraria = i.horarioInicio
                ? i.horarioTermino
                  ? `${i.horarioInicio}–${i.horarioTermino}`
                  : `a partir de ${i.horarioInicio}`
                : null;
              const infoHorario = [turnoItem, faixaHoraria].filter(Boolean).join(" · ");
              return (
                <li key={i.id} className="flex flex-wrap items-start gap-3 py-3">
                  <button
                    onClick={() => podeMarcar && !travaConclusao && toggleItem(c.id, i.id)}
                    disabled={!podeMarcar || travaConclusao}
                    aria-label={
                      bloqueado
                        ? "Rotina desativada hoje"
                        : somenteLeitura
                          ? "Somente leitura — abra o dia de hoje para marcar"
                          : !podeMarcar
                            ? `Rotina atribuída a ${c.responsavel}`
                            : anexosPendentes
                              ? `Anexe os arquivos para concluir ${i.titulo}`
                              : respostaPendente
                                ? `Escolha uma resposta para concluir ${i.titulo}`
                                : justificativaPendente
                                  ? `Preencha a justificativa para concluir ${i.titulo}`
                                  : feito
                                    ? `Reabrir ${i.titulo}`
                                    : `Concluir ${i.titulo}`
                    }
                    className={cn(
                      "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                      feito
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input hover:border-primary",
                      (!podeMarcar || travaConclusao) &&
                        "cursor-not-allowed opacity-50 hover:border-input",
                    )}
                  >
                    {feito && <Check className="size-3.5" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "text-sm font-medium",
                        feito && "text-muted-foreground line-through",
                      )}
                    >
                      {i.titulo}
                    </p>
                    {i.detalhe && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{i.detalhe}</p>
                    )}
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="size-3" /> {labelRecorrencia(i)}
                      </span>
                      <span
                        className={cn("inline-flex items-center gap-1", !infoHorario && "italic")}
                      >
                        <Clock className="size-3" /> {infoHorario || "Sem horário definido"}
                      </span>
                      {i.tipoTarefa === "enquete" && (
                        <span className="inline-flex items-center gap-1">
                          <FileText className="size-3" /> Enquete
                        </span>
                      )}
                      {i.minAnexos > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Paperclip className="size-3" /> {i.minAnexos}{" "}
                          {i.minAnexos === 1 ? "anexo obrigatório" : "anexos obrigatórios"}
                        </span>
                      )}
                    </p>
                    {(i.minAnexos > 0 || i.anexos.length > 0) && (
                      <AnexosItem checklistId={c.id} item={i} podeEditar={podeMarcar && !feito} />
                    )}
                  </div>
                  <div className="shrink-0">
                    <SituacaoItemBadge item={i} checklist={c} agora={agoraParaSituacao(dataFoco, c)} />
                  </div>
                  {i.tipoTarefa === "enquete" && (
                    <>
                      <EnqueteOpcoes
                        checklistId={c.id}
                        item={i}
                        podeEditar={podeMarcar && !feito}
                        className="w-full justify-end sm:w-auto sm:shrink-0 sm:max-w-[45%]"
                      />
                      <JustificativaCampo
                        checklistId={c.id}
                        item={i}
                        podeEditar={podeMarcar && !feito}
                        className="mt-1 basis-full"
                      />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {podeMarcarOutros && !somenteLeitura && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => concluirTodos(c.id)}
                disabled={bloqueado || p.pendentes === 0}
              >
                <Check className="size-4" /> Concluir rotina
              </Button>
              {/* Reabrir em massa exige 'reabrir_rotina' (ou gerência da
                  checklist) — quem só marca não reabre item concluído. */}
              {podeReabrirItem && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => reabrir(c.id)}
                  disabled={bloqueado || p.feitos === 0}
                >
                  <RotateCcw className="size-4" /> Reabrir
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Faixa exibida quando as rotinas de hoje estão desativadas (feriado). Para
 * quem não tem 'pausar_dias' é só informativa; para quem tem, traz o atalho
 * de reativar (a ação "oficial" de pausar/retomar fica no dashboard, em
 * PausaRotinasHoje).
 */
function BannerRotinasPausadas({ hojeISO }: { hojeISO: string }) {
  const { temAcesso } = useAuth();
  const podePausar = temAcesso("pausar_dias");
  const queryClient = useQueryClient();
  const [enviando, setEnviando] = React.useState(false);

  async function reativar() {
    setEnviando(true);
    try {
      await reativarDia(hojeISO);
      toast.success("Rotinas de hoje reativadas.");
      queryClient.invalidateQueries({ queryKey: DIAS_DESATIVADOS_QUERY_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível reativar.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-chart-4/30 bg-chart-4/10 p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-chart-4/20 text-chart-4">
          <CalendarOff className="size-4.5" />
        </span>
        <div>
          <p className="text-sm font-semibold">Rotinas de hoje desativadas</p>
          <p className="text-xs text-muted-foreground">
            A marcação de itens está travada hoje.{" "}
            {podePausar ? "Reative para voltar a registrar." : "Fale com o administrador."}
          </p>
        </div>
      </div>
      {podePausar && (
        <Button size="sm" variant="outline" disabled={enviando} onClick={reativar}>
          {enviando ? "Reativando…" : "Reativar rotinas de hoje"}
        </Button>
      )}
    </section>
  );
}

const fmtDataTarefa = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });
const fmtDiaLongo = new Intl.DateTimeFormat("pt-BR", {
  weekday: "long",
  day: "2-digit",
  month: "long",
});

/**
 * Uma tarefa (item) do funcionário: o item em si, a rotina a que pertence e o
 * estado derivado só daquela tarefa — concluída, atrasada (rotina passou do
 * tempo limite sem terminar), pendente (no horário) ou não iniciada (rotina
 * ainda fora da janela). Um item nunca fica "em andamento".
 */
interface TarefaFuncionario {
  checklist: Checklist;
  item: ChecklistItem;
  estado: EstadoVista;
}

function estadoDaTarefa(c: Checklist, i: ChecklistItem, ehHoje: boolean): EstadoVista {
  if (i.status === "concluido") return "concluido";
  if (!ehHoje) return "nao_iniciada";
  const ev = estadoVista(c);
  return ev === "atrasada" ? "atrasada" : ev === "nao_iniciada" ? "nao_iniciada" : "pendente";
}

/**
 * Linha da lista de tarefas do funcionário: check para concluir + título da
 * tarefa, a rotina a que pertence logo abaixo e, no fim da linha, horário, data
 * e o estado atual.
 */
function TarefaRow({
  tarefa,
  data,
  bloqueado,
}: {
  tarefa: TarefaFuncionario;
  data: Date;
  bloqueado: boolean;
}) {
  const { toggleItem } = useGCheck();
  const { isAdmin, temAcesso } = useAuth();
  // Reabrir uma tarefa já concluída exige a permissão específica (ou admin) —
  // por padrão um funcionário só conclui, nunca desmarca. Mesma regra do
  // ChecklistCard, reforçada no banco pela migration 20260908160000_cargos_permissoes.sql.
  const podeReabrir = isAdmin || temAcesso("reabrir_rotina");
  const { checklist: c, item: i, estado: est } = tarefa;
  const feito = i.status === "concluido";
  // Tarefa que ainda não tem os anexos mínimos: bloqueia a conclusão até anexar.
  const anexosPendentes = i.anexos.length < i.minAnexos && !feito;
  const respostaPendente = i.tipoTarefa === "enquete" && !i.resposta && !feito;
  // Enquete sem justificativa preenchida: idem — obrigatória pra concluir.
  const justificativaPendente = i.tipoTarefa === "enquete" && !i.justificativa?.trim() && !feito;
  const travaConclusao = anexosPendentes || respostaPendente || justificativaPendente;
  const travado = bloqueado || travaConclusao || (feito && !podeReabrir);

  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 p-4">
      <button
        onClick={() => !travado && toggleItem(c.id, i.id)}
        disabled={travado}
        aria-label={
          bloqueado
            ? "Rotina desativada hoje"
            : feito
              ? podeReabrir
                ? `Reabrir ${i.titulo}`
                : `${i.titulo} concluída — só um administrador pode reabrir`
              : anexosPendentes
                ? `Anexe os arquivos para concluir ${i.titulo}`
                : respostaPendente
                  ? `Escolha uma resposta para concluir ${i.titulo}`
                  : justificativaPendente
                    ? `Preencha a justificativa para concluir ${i.titulo}`
                    : `Concluir ${i.titulo}`
        }
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors",
          feito
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input hover:border-primary",
          travado && "cursor-not-allowed opacity-50 hover:border-input",
          feito && !podeReabrir && "cursor-default",
        )}
      >
        {feito && <Check className="size-3.5" />}
      </button>

      <div className="min-w-0 flex-1 basis-48">
        <p
          className={cn(
            "break-words text-sm font-medium",
            feito && "text-muted-foreground line-through",
          )}
        >
          {i.titulo}
        </p>
        <p className="truncate text-xs text-muted-foreground">{c.nome}</p>
        {(i.minAnexos > 0 || i.anexos.length > 0) && (
          <AnexosItem checklistId={c.id} item={i} podeEditar={!bloqueado && !feito} />
        )}
        {i.tipoTarefa === "enquete" && (
          <div className="mt-2 space-y-2">
            <EnqueteOpcoes checklistId={c.id} item={i} podeEditar={!bloqueado && !feito} />
            <JustificativaCampo checklistId={c.id} item={i} podeEditar={!bloqueado && !feito} />
          </div>
        )}
      </div>

      <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-8 sm:w-auto sm:justify-end sm:pl-0">
        <div className="flex shrink-0 flex-col items-start gap-0.5 text-xs text-muted-foreground sm:items-end">
          {(i.horarioInicio || i.turno) && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <Clock className="size-3.5" />{" "}
              {[
                i.turno,
                i.horarioInicio &&
                  (i.horarioTermino ? `${i.horarioInicio}–${i.horarioTermino}` : i.horarioInicio),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <CalendarDays className="size-3.5" /> {fmtDataTarefa.format(data)}
          </span>
        </div>
        {feito ? (
          <SituacaoItemBadge item={i} checklist={c} agora={agoraParaSituacao(data, c)} />
        ) : (
          <Badge
            variant="outline"
            className={cn("shrink-0 border-transparent font-medium", ESTADO_VISTA_UI[est].classe)}
          >
            {ESTADO_VISTA_UI[est].label}
          </Badge>
        )}
      </div>
    </li>
  );
}

function TarefasFuncionarioLista({
  tarefas,
  data,
  bloqueado,
  comFiltro,
  somenteLeitura = false,
}: {
  tarefas: TarefaFuncionario[];
  data: Date;
  bloqueado: boolean;
  comFiltro: boolean;
  somenteLeitura?: boolean | undefined;
}) {
  if (tarefas.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {comFiltro
          ? "Nenhuma tarefa para esse recorte."
          : somenteLeitura
            ? "Nenhuma tarefa sua nesse dia."
            : "Você não tem tarefas para hoje."}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {tarefas.map((t) => (
        <TarefaRow
          key={`${t.checklist.id}-${t.item.id}`}
          tarefa={t}
          data={data}
          bloqueado={bloqueado}
        />
      ))}
    </ul>
  );
}

function ChecklistsPage() {
  const { checklists, isLoading, isError } = useGCheck();
  const { session, isAdmin, temAcesso, profile } = useAuth();
  // Acesso amplo: admin sempre; funcionário conforme as permissões do cargo.
  // 'marcar_checklists_outros' também entra aqui — pra marcar item de rotina
  // alheia dá pra ver a lista completa de checklists, não só a própria.
  const podeVerTodas =
    isAdmin || temAcesso("consultar_checklists_outros") || temAcesso("marcar_checklists_outros");
  const podeCriar = isAdmin || temAcesso("criar_checklist");
  const podeVerHistorico = isAdmin || temAcesso("ver_historico");
  const { hojeISO, hojeDesativado } = useHojeDesativado();
  const {
    estados,
    tarefas: tarefasSearch,
    turnos: turnosSearch,
    horarioDe,
    horarioAte,
    funcionarios: funcionariosSearch,
    checklist: checklistDestaque,
    dia,
    vista,
    secao,
  } = Route.useSearch();
  const navigate = Route.useNavigate();
  // "Minhas" só existe pra quem também enxerga a lista completa — troca a
  // lista de cards pelo mesmo formato enxuto do funcionário comum (rotina já
  // aberta, só as próprias atividades).
  const verMinhas = podeVerTodas && secao === "minhas";

  // Dia em foco: sem "?dia=" (ou dia === hoje) é o dia corrente e tudo pode ser
  // marcado; "todas" mostra todas as atividades sem recorte; qualquer outro dia é
  // somente-leitura (abre para ver, não marca).
  const ehTodas = dia === "todas";
  const ehQuinzenal = dia === "quinzenal";
  const ehMensal = dia === "mensal";
  // Recortes que ignoram o dia do calendário (visões transversais só-leitura).
  const ehRecorteSemDia = ehTodas || ehQuinzenal || ehMensal;
  const ehHoje = !dia || dia === hojeISO;
  const ehPassado = !!dia && !ehHoje && !ehRecorteSemDia && dataDoIso(dia) < dataDoIso(hojeISO);
  const somenteLeitura = !ehHoje;

  // Registro de um dia já fechado (snapshot em checklist_execucoes) — leitura
  // exige 'ver_historico' (RLS). Alimenta as cards quando dá pra ver o
  // histórico e a navegação vai para um dia passado.
  const execucoesDiaQuery = useQuery({
    queryKey: [...HISTORICO_QUERY_KEY, dia ?? "", dia ?? ""],
    queryFn: () => fetchExecucoes(dia ?? "", dia ?? ""),
    enabled: !!session && podeVerHistorico && ehPassado,
  });

  // Nomes das contas admin — só pra personalizados com acesso amplo
  // (consultar/marcar checklists dos demais), que não veem a tabela profiles
  // inteira via RLS. Usado pra esconder rotinas cujo responsável é um admin
  // (ver `minhasChecklists` abaixo). Admin não precisa: já vê tudo.
  const nomesAdminQuery = useQuery({
    queryKey: NOMES_ADMIN_QUERY_KEY,
    queryFn: fetchNomesAdmin,
    enabled: !!session && podeVerTodas && !isAdmin,
  });
  const nomesAdminSet = React.useMemo(
    () => new Set((nomesAdminQuery.data ?? []).map((n) => n.trim().toLowerCase())),
    [nomesAdminQuery.data],
  );

  const estadosSelecionados = React.useMemo(() => estados ?? [], [estados]);
  const tarefasSelecionadas = React.useMemo(() => tarefasSearch ?? [], [tarefasSearch]);
  const turnosSelecionados = React.useMemo(() => turnosSearch ?? [], [turnosSearch]);
  const funcionariosSelecionados = React.useMemo(
    () => funcionariosSearch ?? [],
    [funcionariosSearch],
  );

  // Opções de Funcionário saem das próprias rotinas (todas, não só as do dia):
  // assim o filtro cobre qualquer valor já cadastrado, mesmo fora do recorte
  // atual. Ordenadas em pt-BR, sem repetição e sem entradas vazias.
  const funcionariosDisponiveis = React.useMemo(() => {
    const nomes = new Set<string>();
    for (const c of checklists) {
      const r = c.responsavel.trim();
      if (r) nomes.add(r);
    }
    return [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [checklists]);

  // Horários de início realmente cadastrados nos itens ("HH:MM"), sem repetição
  // e em ordem crescente — viram sugestões (datalist) nos campos De/Até do filtro.
  const horariosDisponiveis = React.useMemo(() => {
    const valores = new Set<string>();
    for (const c of checklists) {
      for (const i of c.itens) {
        if (i.horarioInicio) valores.add(i.horarioInicio);
      }
    }
    return [...valores].sort((a, b) => a.localeCompare(b));
  }, [checklists]);

  const toggleEstado = React.useCallback(
    (id: EstadoFiltro) => {
      navigate({
        search: (prev) => {
          const atuais = prev.estados ?? [];
          const proximo = atuais.includes(id) ? atuais.filter((e) => e !== id) : [...atuais, id];
          return { ...prev, estados: proximo.length ? proximo : undefined };
        },
      });
    },
    [navigate],
  );

  const toggleTarefa = React.useCallback(
    (id: FiltroTarefa) => {
      navigate({
        search: (prev) => {
          const atuais = prev.tarefas ?? [];
          const proximo = atuais.includes(id) ? atuais.filter((t) => t !== id) : [...atuais, id];
          return { ...prev, tarefas: proximo.length ? proximo : undefined };
        },
      });
    },
    [navigate],
  );

  const toggleTurno = React.useCallback(
    (id: Turno) => {
      navigate({
        search: (prev) => {
          const atuais = prev.turnos ?? [];
          const proximo = atuais.includes(id) ? atuais.filter((t) => t !== id) : [...atuais, id];
          return { ...prev, turnos: proximo.length ? proximo : undefined };
        },
      });
    },
    [navigate],
  );

  const mudarHorario = React.useCallback(
    (patch: { de?: string | undefined; ate?: string | undefined }) => {
      navigate({
        search: (prev) => ({
          ...prev,
          ...("de" in patch ? { horarioDe: patch.de || undefined } : {}),
          ...("ate" in patch ? { horarioAte: patch.ate || undefined } : {}),
        }),
      });
    },
    [navigate],
  );

  const toggleFuncionario = React.useCallback(
    (id: string) => {
      navigate({
        search: (prev) => {
          const atuais = prev.funcionarios ?? [];
          const proximo = atuais.includes(id) ? atuais.filter((f) => f !== id) : [...atuais, id];
          return { ...prev, funcionarios: proximo.length ? proximo : undefined };
        },
      });
    },
    [navigate],
  );

  const limparFiltros = React.useCallback(() => {
    navigate({
      search: (prev) => ({
        ...prev,
        estados: undefined,
        tarefas: undefined,
        turnos: undefined,
        horarioDe: undefined,
        horarioAte: undefined,
        funcionarios: undefined,
      }),
    });
  }, [navigate]);

  const selecionarDia = React.useCallback(
    (iso: string | undefined) => {
      navigate({ search: (prev) => ({ ...prev, dia: iso || undefined }) });
    },
    [navigate],
  );

  const abrirCalendario = React.useCallback(() => {
    navigate({ search: (prev) => ({ ...prev, vista: "calendario" }) });
  }, [navigate]);

  const fecharCalendario = React.useCallback(() => {
    navigate({ search: (prev) => ({ ...prev, vista: undefined }) });
  }, [navigate]);

  const abrirDia = React.useCallback(
    (iso: string) => {
      navigate({ search: (prev) => ({ ...prev, dia: iso, vista: undefined }) });
    },
    [navigate],
  );

  const selecionarSecao = React.useCallback(
    (proxima: "minhas" | undefined) => {
      navigate({ search: (prev) => ({ ...prev, secao: proxima }) });
    },
    [navigate],
  );

  if (isLoading) {
    return (
      <AppShell title="Checklists" subtitle="Rotinas operacionais da Loja Matriz">
        <p className="text-sm text-muted-foreground">Carregando rotinas…</p>
      </AppShell>
    );
  }

  if (isError) {
    return (
      <AppShell title="Checklists" subtitle="Rotinas operacionais da Loja Matriz">
        <p className="text-sm text-destructive">Não foi possível carregar as rotinas.</p>
      </AppShell>
    );
  }

  // Personalizado com acesso amplo (não-admin) não vê rotina cujo responsável
  // é uma conta admin — mesmo enxergando "todas as rotinas". Admin sempre vê
  // tudo, inclusive as de outros admins.
  const minhasChecklists = podeVerTodas
    ? isAdmin
      ? checklists
      : checklists.filter((c) => !nomesAdminSet.has(c.responsavel.trim().toLowerCase()))
    : checklists.filter((c) => c.ativo && ehResponsavel(c, profile?.nome));

  if (vista === "calendario") {
    return (
      <AppShell title="Checklists" subtitle="Calendário de rotinas">
        <CalendarioChecklists
          checklists={minhasChecklists}
          diaInicial={ehRecorteSemDia ? undefined : dia}
          onVoltar={fecharCalendario}
          onAbrirDia={abrirDia}
        />
      </AppShell>
    );
  }

  // Data em foco: o dia escolhido no seletor ou hoje (nos recortes sem dia
  // — todas/quinzenal/mensal — não há data, então usa hoje só como referência).
  const dataAlvo = dia && !ehRecorteSemDia ? dataDoIso(dia) : new Date();
  const diaSelecionado = !!dia && !ehHoje;

  // Recorta a rotina para o dia em foco: mantém só as atividades cuja recorrência
  // (semanal/quinzenal/mensal, por item) cai em `dataAlvo`. Rotina de folga
  // nesse dia (diasPausados) fica sem nenhum item, como se nada batesse a
  // recorrência. Rotina sem nenhuma atividade no dia é descartada mais abaixo.
  // Em "hoje" (ao vivo), uma rotina com corteDia (turno que atravessa a
  // meia-noite) ainda conta como o dia em que o turno começou até o corte
  // passar — ver diaOperacionalChecklist. Num dia explicitamente escolhido
  // (passado/futuro) o recorte continua sendo o dia calendário mesmo.
  const recortarDia = (c: Checklist): Checklist => {
    // IMPORTANTE: usa o instante real (`new Date()`), não `dataAlvo` — quando o
    // dia foi escolhido explicitamente como "hoje" (ex.: botão "Hoje" do
    // seletor), `dataAlvo` vem de `dataDoIso` e é meia-noite (00:00), não a
    // hora atual. Passar meia-noite pra `diaOperacionalChecklist` fazia toda
    // rotina com corteDia parecer "antes do corte" o dia inteiro, prendendo-a
    // permanentemente no dia anterior mesmo depois do corte já ter passado.
    const dataRef = ehHoje ? diaOperacionalChecklist(c, new Date()) : dataAlvo;
    return {
      ...c,
      itens: checklistPausadaNoDia(c, dataRef) ? [] : c.itens.filter((i) => itemRodaNoDia(i, dataRef)),
    };
  };

  // "?dia=quinzenal|mensal": mostra todas as rotinas, mas só com as atividades
  // daquela recorrência — visão transversal, sem recorte por dia.
  const recortarPorRecorrencia =
    (rec: ChecklistItem["recorrencia"]) =>
    (c: Checklist): Checklist => ({
      ...c,
      itens: c.itens.filter((i) => i.recorrencia === rec),
    });

  // Base de dados do dia em foco:
  //  - todas             -> todas as rotinas com todos os itens (somente leitura);
  //  - hoje              -> estado ao vivo (checklist_items), pode marcar;
  //  - passado (com ver_historico) -> snapshot congelado em checklist_execucoes (já filtrado);
  //  - futuro, ou passado sem acesso ao histórico -> estrutura da rotina
  //    recortada para o dia, com todos os itens "pendente".
  // Nos casos que não são "hoje" as cards ficam somente-leitura.
  const checklistsDoDia: Checklist[] = (
    ehTodas
      ? minhasChecklists
      : ehQuinzenal
        ? minhasChecklists.map(recortarPorRecorrencia("quinzenal"))
        : ehMensal
          ? minhasChecklists.map(recortarPorRecorrencia("mensal"))
          : ehHoje
            ? minhasChecklists.map(recortarDia)
            : ehPassado && podeVerHistorico
              ? (execucoesDiaQuery.data ?? []).map((e) =>
                  checklistDeSnapshot(
                    e,
                    checklists.find((c) => c.id === e.checklist_id),
                  ),
                )
              : minhasChecklists
                  .filter((c) => checklistVigenteNoDia(c, dataAlvo))
                  .map(recortarDia)
                  .map(checklistPendente)
  ).filter((c) => c.itens.length > 0 || checklistPausadaNoDia(c, dataAlvo));

  // Recorte por responsável da rotina — vale para qualquer dia em foco, então
  // roda antes das ramificações de estado abaixo.
  const passaFuncionario = (c: Checklist) =>
    funcionariosSelecionados.length === 0 ||
    funcionariosSelecionados.includes(c.responsavel.trim());

  const passaTurno = (c: Checklist) =>
    turnosSelecionados.length === 0 ||
    c.turnos.some((t) => turnosSelecionados.includes(t as Turno));

  // Um "HH:MM" cai dentro do intervalo De–Até (qualquer limite pode faltar).
  const horarioNaFaixa = (hhmm: string | null) => {
    if (!hhmm) return false;
    if (horarioDe && hhmm < horarioDe) return false;
    if (horarioAte && hhmm > horarioAte) return false;
    return true;
  };

  // O filtro de horário age nas ATIVIDADES, não na rotina: com uma faixa De–Até
  // definida, cada card mostra só os itens que começam dentro dela — e o
  // progresso/estado passam a refletir esse recorte. Rotina que fica sem
  // nenhuma atividade no intervalo é descartada.
  const temFiltroHorario = !!horarioDe || !!horarioAte;
  const recortarHorario = (c: Checklist): Checklist => {
    if (!temFiltroHorario) return c;
    const itens = c.itens.filter((i) => horarioNaFaixa(i.horarioInicio));
    // Recalcula turnos/faixa do cabeçalho a partir só das atividades que restaram.
    return { ...c, itens, ...descricaoAgenda(itens, c.corteDia) };
  };

  // Filtro de Tarefa (ex.: "Concluídas atrasadas"): mesma ideia do de horário
  // — não esconde a rotina, só recorta os itens dela pros que passam. A rotina
  // continua na lista, só que mostrando apenas as atividades filtradas.
  const temFiltroTarefa = tarefasSelecionadas.length > 0;
  const recortarTarefa = (c: Checklist): Checklist => {
    if (!temFiltroTarefa) return c;
    const itens = c.itens.filter((i) => passaFiltroTarefa(i, c, tarefasSelecionadas));
    return { ...c, itens, ...descricaoAgenda(itens, c.corteDia) };
  };

  const lista = checklistsDoDia
    .map(recortarHorario)
    .map(recortarTarefa)
    .filter((c) => {
      if (temFiltroHorario && c.itens.length === 0 && !checklistPausadaNoDia(c, dataAlvo)) {
        return false;
      }
      if (temFiltroTarefa && c.itens.length === 0 && !checklistPausadaNoDia(c, dataAlvo)) {
        return false;
      }
      if (!passaTurno(c)) return false;
      if (!passaFuncionario(c)) return false;
      if (!ehHoje) {
        return passaFiltroEstado(estadoVistaCard(c, false, dataAlvo), estadosSelecionados);
      }
      return passaFiltroEstado(estadoVista(c), estadosSelecionados);
    })
    // Ativas primeiro; de folga hoje depois; inativas (desativadas no
    // cadastro) por último. Sort estável preserva a ordem (horário/nome) já
    // aplicada dentro de cada grupo.
    .sort((a, b) => rankInatividade(a, dataAlvo) - rankInatividade(b, dataAlvo));

  // Funcionário comum (ou quem escolheu a aba "Minhas") não vê a rotina
  // inteira: percorre as rotinas de que é responsável (nas que passam pelos
  // mesmos filtros de turno/dia) e monta uma lista plana de tarefas, ordenada
  // pelo que precisa de ação primeiro.
  const tarefasFuncionario: TarefaFuncionario[] =
    podeVerTodas && !verMinhas
      ? []
      : checklistsDoDia
          .filter((c) => passaTurno(c) && passaFuncionario(c) && ehResponsavel(c, profile?.nome))
          .flatMap((c) =>
            c.itens
              .filter((i) => {
                if (turnosSelecionados.length === 0) return true;
                const t = i.turno ?? turnoDoHorario(i.horarioInicio);
                return !t || turnosSelecionados.includes(t as Turno);
              })
              .filter((i) => (!horarioDe && !horarioAte) || horarioNaFaixa(i.horarioInicio))
              .filter((i) => passaFiltroTarefa(i, c, tarefasSelecionadas))
              .map((i) => ({ checklist: c, item: i, estado: estadoDaTarefa(c, i, ehHoje) })),
          )
          .filter((t) => passaFiltroEstado(t.estado, estadosSelecionados))
          .sort((a, b) => {
            // Ciclo do corte da própria rotina de cada tarefa (ver
            // minutosNoCiclo) — senão uma tarefa de madrugada (ex.: 00:30)
            // apareceria antes da que abre o turno à noite (ex.: 23:00).
            const horaA = a.item.horarioInicio ?? a.checklist.horarioInicio;
            const horaB = b.item.horarioInicio ?? b.checklist.horarioInicio;
            const ma = horaA ? minutosNoCiclo(horaA, a.checklist.corteDia) : Infinity;
            const mb = horaB ? minutosNoCiclo(horaB, b.checklist.corteDia) : Infinity;
            return ma === mb ? a.item.titulo.localeCompare(b.item.titulo) : ma - mb;
          });

  const temFiltro =
    estadosSelecionados.length > 0 ||
    tarefasSelecionadas.length > 0 ||
    turnosSelecionados.length > 0 ||
    !!horarioDe ||
    !!horarioAte ||
    funcionariosSelecionados.length > 0 ||
    diaSelecionado;

  const carregandoDia = ehPassado && podeVerHistorico && execucoesDiaQuery.isLoading;

  return (
    <AppShell
      title="Checklists"
      subtitle={
        podeVerTodas && !verMinhas ? "Rotinas operacionais da Loja Matriz" : "Suas tarefas do dia"
      }
    >
      <div className="mx-auto max-w-4xl space-y-5">
        {hojeDesativado && <BannerRotinasPausadas hojeISO={hojeISO} />}

        {podeVerTodas && (
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={verMinhas ? "minhas" : "todas"}
            onValueChange={(v) => v && selecionarSecao(v === "minhas" ? "minhas" : undefined)}
          >
            <ToggleGroupItem value="todas" className="gap-1.5 px-3">
              <Users className="size-4" /> Todas as rotinas
            </ToggleGroupItem>
            <ToggleGroupItem value="minhas" className="gap-1.5 px-3">
              <User className="size-4" /> Minhas tarefas
            </ToggleGroupItem>
          </ToggleGroup>
        )}

        {somenteLeitura && (
          <section className="flex items-center gap-3 rounded-2xl border border-border bg-muted/40 p-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Eye className="size-4.5" />
            </span>
            <div>
              <p className="text-sm font-semibold capitalize">
                {ehTodas
                  ? "Todas as atividades"
                  : ehQuinzenal
                    ? "Atividades quinzenais"
                    : ehMensal
                      ? "Atividades mensais"
                      : fmtDiaLongo.format(dataAlvo)}
              </p>
              <p className="text-xs text-muted-foreground">
                {ehTodas
                  ? "Todas as atividades de todas as rotinas, independente do dia."
                  : ehQuinzenal
                    ? "Atividades com recorrência quinzenal, de todas as rotinas."
                    : ehMensal
                      ? "Atividades com recorrência mensal, de todas as rotinas."
                      : ehPassado
                        ? "Registro de um dia já fechado — somente leitura."
                        : "Este dia ainda não chegou — somente leitura."}{" "}
                As atividades só podem ser marcadas no dia programado.
              </p>
            </div>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <FiltrosChecklist
              estadosSelecionados={estadosSelecionados}
              tarefasSelecionadas={tarefasSelecionadas}
              turnosSelecionados={turnosSelecionados}
              horarioDe={horarioDe}
              horarioAte={horarioAte}
              funcionariosSelecionados={funcionariosSelecionados}
              horariosDisponiveis={horariosDisponiveis}
              funcionariosDisponiveis={funcionariosDisponiveis}
              onToggleEstado={toggleEstado}
              onToggleTarefa={toggleTarefa}
              onToggleTurno={toggleTurno}
              onChangeHorario={mudarHorario}
              onToggleFuncionario={toggleFuncionario}
              onLimpar={limparFiltros}
            />
            <SeletorDia
              diaSelecionado={dia}
              onSelectDia={selecionarDia}
              onVerCalendario={abrirCalendario}
              checklists={minhasChecklists}
            />
          </div>
          {podeCriar && <NovaChecklistDialog />}
        </div>

        {podeVerTodas && !verMinhas ? (
          <div className="space-y-4">
            {carregandoDia ? (
              <p className="text-sm text-muted-foreground">Carregando registro do dia…</p>
            ) : (
              <>
                {lista.map((c) => (
                  <ChecklistCard
                    key={c.id}
                    c={c}
                    destacar={c.id === checklistDestaque}
                    travado={hojeDesativado}
                    somenteLeitura={somenteLeitura}
                    diaFechado={ehPassado}
                    dataFoco={dataAlvo}
                  />
                ))}
                {lista.length === 0 && (
                  <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    {ehTodas
                      ? "Nenhuma rotina cadastrada."
                      : ehQuinzenal
                        ? "Nenhuma atividade quinzenal cadastrada."
                        : ehMensal
                          ? "Nenhuma atividade mensal cadastrada."
                          : somenteLeitura
                            ? ehPassado
                              ? "Nenhuma rotina registrada nesse dia."
                              : "Nenhuma atividade programada para esse dia."
                            : diaSelecionado
                              ? "Nenhuma atividade para o dia escolhido."
                              : temFiltroHorario
                                ? "Nenhuma atividade no horário escolhido."
                                : "Nenhuma rotina neste estado."}
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <TarefasFuncionarioLista
            tarefas={tarefasFuncionario}
            data={dataAlvo}
            bloqueado={hojeDesativado || somenteLeitura}
            comFiltro={temFiltro}
            somenteLeitura={somenteLeitura}
          />
        )}
      </div>
    </AppShell>
  );
}
