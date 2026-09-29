import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  CalendarCheck,
  CalendarCog,
  CalendarOff,
  CheckCircle2,
  Clock,
  List,
  ListChecks,
  PieChart as PieChartIcon,
  TrendingUp,
  Users,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";
import { AppShell } from "@/components/app-shell";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ChecklistSearch } from "@/routes/checklists";
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
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { cn, dataDoIso, isoDoDia } from "@/lib/utils";
import { useAuth } from "@/lib/auth-store";
import {
  desativarDia,
  DIAS_DESATIVADOS_QUERY_KEY,
  reativarDia,
  useDiasDesativados,
  useHojeDesativado,
} from "@/lib/dias-desativados";
import { fetchNomesAdmin, NOMES_ADMIN_QUERY_KEY } from "@/lib/profiles";
import {
  checklistPausadaNoDia,
  diaOperacionalChecklist,
  ehResponsavel,
  estado,
  estadoLabel,
  itemRodaNoDia,
  naoIniciada,
  progresso,
  tarefasPorFuncionario,
  useGCheck,
  type AgregadoTarefas,
  type Checklist,
} from "@/lib/g-check-store";

/**
 * Só tem efeito pra quem enxerga todas as rotinas (admin/'consultar_checklists_outros'/
 * 'marcar_checklists_outros'): "minhas" troca o resumo do dia inteiro pelo
 * recorte das próprias tarefas — mesma aba que existe em /checklists.
 */
interface DashboardSearch {
  secao?: "minhas" | undefined;
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "G-check — Dashboard de rotinas do supermercado" },
      {
        name: "description",
        content:
          "Visão rápida de pendências, checklists concluídos e taxa de execução das rotinas da sua loja.",
      },
      { property: "og:title", content: "G-check — Dashboard de rotinas do supermercado" },
      {
        property: "og:description",
        content: "Acompanhe pendências, conclusões e taxa de execução em tempo real.",
      },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): DashboardSearch => {
    const secao = search["secao"] === "minhas" ? "minhas" : undefined;
    return { ...(secao ? { secao } : {}) };
  },
  component: Dashboard,
});

function Metric({
  label,
  value,
  hint,
  icon: Icon,
  tone,
  search,
}: {
  label: string;
  value: string;
  hint: string;
  icon: typeof Clock;
  tone: "primary" | "success" | "warn" | "danger" | "neutral" | "info";
  /** Se informado, o card vira um link para /checklists já com esse filtro. */
  search?: ChecklistSearch | undefined;
}) {
  const base = "rounded-2xl border border-border bg-card p-5 shadow-sm";
  const conteudo = (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{label}</p>
        <span
          className={cn(
            "flex size-9 items-center justify-center rounded-xl",
            tone === "primary" && "bg-primary/12 text-primary",
            tone === "success" && "bg-success/15 text-success",
            tone === "warn" && "bg-chart-4/20 text-chart-4",
            tone === "danger" && "bg-destructive/15 text-destructive",
            tone === "neutral" && "bg-muted text-muted-foreground",
            tone === "info" && "bg-info/15 text-info",
          )}
        >
          <Icon className="size-4.5" />
        </span>
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </>
  );

  if (search) {
    return (
      <Link
        to="/checklists"
        search={search}
        className={cn(base, "block transition-colors hover:border-primary/40 hover:bg-primary/5")}
      >
        {conteudo}
      </Link>
    );
  }

  return <div className={base}>{conteudo}</div>;
}

/** Modos de visualização do card de tarefas por funcionário. */
type VistaTarefas = "barras" | "pizza" | "colunas";

/** Paleta cíclica p/ o gráfico de pizza (uma fatia por funcionário). */
const PALETA_TAREFAS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/** Cor da fatia i, ciclando na paleta (nunca undefined). */
function corDaFatia(i: number): string {
  return PALETA_TAREFAS[i % PALETA_TAREFAS.length] ?? "var(--chart-1)";
}

/** Config compartilhada dos gráficos que quebram por status (colunas empilhadas). */
const chartConfigStatus = {
  feitos: { label: "Concluídas", color: "var(--success)" },
  noPrazo: { label: "Pendentes", color: "var(--chart-4)" },
  atrasados: { label: "Atrasadas", color: "var(--destructive)" },
} satisfies ChartConfig;

/**
 * Vista "barras": uma linha por funcionário com barra 100% preenchida,
 * dividida entre concluídas (verde), atrasadas (vermelho) e pendentes no prazo
 * (âmbar) pela contagem da própria linha. Ordenada por pendências.
 */
function BarrasTarefas({ dados, rotuloItem }: { dados: AgregadoTarefas[]; rotuloItem: string }) {
  return (
    <ul className="mt-4 space-y-3">
      {dados.map((d) => (
        <li key={d.chave} className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium">{d.chave}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {d.atrasados > 0 ? (
                <span className="font-medium text-destructive">
                  {d.atrasados} atrasada{d.atrasados > 1 ? "s" : ""}
                </span>
              ) : d.pendentes > 0 ? (
                <span className="font-medium text-chart-4">
                  {d.pendentes} pendente{d.pendentes > 1 ? "s" : ""}
                </span>
              ) : (
                <span className="font-medium text-success">em dia</span>
              )}{" "}
              · {d.total} {d.total === 1 ? rotuloItem : `${rotuloItem}s`}
            </span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="bg-success"
              style={{ width: `${d.total ? (d.feitos / d.total) * 100 : 0}%` }}
            />
            <div
              className="bg-destructive"
              style={{ width: `${d.total ? (d.atrasados / d.total) * 100 : 0}%` }}
            />
            <div
              className="bg-chart-4"
              style={{
                width: `${d.total ? ((d.pendentes - d.atrasados) / d.total) * 100 : 0}%`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Vista "pizza": distribuição do volume total de tarefas por funcionário. */
function PizzaTarefas({ dados }: { dados: AgregadoTarefas[] }) {
  const data = dados.map((d, i) => ({
    chave: d.chave,
    total: d.total,
    fill: corDaFatia(i),
  }));
  const config: ChartConfig = Object.fromEntries(
    dados.map((d, i) => [d.chave, { label: d.chave, color: corDaFatia(i) }]),
  );

  return (
    <ChartContainer config={config} className="mx-auto mt-4 aspect-square w-full max-w-[260px]">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent nameKey="chave" hideLabel />} />
        <Pie data={data} dataKey="total" nameKey="chave" innerRadius={55} strokeWidth={2}>
          {data.map((d) => (
            <Cell key={d.chave} fill={d.fill} />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent nameKey="chave" />} className="flex-wrap" />
      </PieChart>
    </ChartContainer>
  );
}

/** Vista "colunas": barras verticais empilhadas por status (feito/pendente/atrasado). */
function ColunasTarefas({ dados }: { dados: AgregadoTarefas[] }) {
  const data = dados.map((d) => ({
    chave: d.chave,
    feitos: d.feitos,
    noPrazo: Math.max(0, d.pendentes - d.atrasados),
    atrasados: d.atrasados,
  }));

  return (
    <ChartContainer config={chartConfigStatus} className="mt-4 aspect-auto h-[260px] w-full">
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="chave"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v: string) => (v.length > 10 ? `${v.slice(0, 9)}…` : v)}
        />
        <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={28} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="feitos" stackId="a" fill="var(--color-feitos)" radius={[0, 0, 4, 4]} />
        <Bar dataKey="noPrazo" stackId="a" fill="var(--color-noPrazo)" />
        <Bar dataKey="atrasados" stackId="a" fill="var(--color-atrasados)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

/**
 * Card do dashboard com a quebra de tarefas por funcionário. O cabeçalho traz
 * um seletor com 3 formas de ver os mesmos dados: barras (lista), pizza
 * (distribuição do volume) e colunas (empilhado por status).
 */
function TarefasBreakdown({
  titulo,
  descricao,
  icon: Icon,
  dados,
  vazio,
  rotuloItem,
}: {
  titulo: string;
  descricao: string;
  icon: typeof Users;
  dados: AgregadoTarefas[];
  vazio: string;
  /** singular do que cada tarefa representa, p/ concordância ("tarefa"/"tarefas"). */
  rotuloItem: string;
}) {
  const [vista, setVista] = React.useState<VistaTarefas>("barras");

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold tracking-tight">{titulo}</h2>
            <p className="truncate text-xs text-muted-foreground">{descricao}</p>
          </div>
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={vista}
          onValueChange={(v) => v && setVista(v as VistaTarefas)}
          className="shrink-0"
        >
          <ToggleGroupItem value="barras" aria-label="Ver em barras">
            <List className="size-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="pizza" aria-label="Ver em pizza">
            <PieChartIcon className="size-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="colunas" aria-label="Ver em colunas">
            <BarChart3 className="size-4" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {dados.length === 0 ? (
        <p className="mt-4 rounded-xl bg-muted/60 p-4 text-sm text-muted-foreground">{vazio}</p>
      ) : vista === "barras" ? (
        <BarrasTarefas dados={dados} rotuloItem={rotuloItem} />
      ) : vista === "pizza" ? (
        <PizzaTarefas dados={dados} />
      ) : (
        <ColunasTarefas dados={dados} />
      )}
    </section>
  );
}

const fmtDataCurta = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const fmtDataExtenso = new Intl.DateTimeFormat("pt-BR", {
  weekday: "long",
  day: "2-digit",
  month: "long",
  year: "numeric",
});

/**
 * Popover com um calendário para o admin programar/desfazer dias sem expediente
 * em QUALQUER data (não só hoje). Dias já desativados aparecem destacados; clicar
 * num dia abre a confirmação e alterna a marca em `dias_desativados` — a mesma
 * tabela usada por PausaRotinasHoje e refletida no histórico.
 */
function PersonalizarRotinas() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const { datas } = useDiasDesativados();
  const [aberto, setAberto] = React.useState(false);
  const [mes, setMes] = React.useState(() => dataDoIso(isoDoDia(new Date())));
  const [alvo, setAlvo] = React.useState<Date | null>(null);
  const [enviando, setEnviando] = React.useState(false);

  const hoje = React.useMemo(() => dataDoIso(isoDoDia(new Date())), []);
  const diasDesativados = React.useMemo(() => datas.map((iso) => dataDoIso(iso)), [datas]);

  const alvoISO = alvo ? isoDoDia(alvo) : null;
  const alvoDesativado = alvoISO ? datas.includes(alvoISO) : false;

  function escolherDia(d: Date | undefined) {
    if (!d) return;
    setAberto(false);
    setAlvo(d);
  }

  async function confirmar() {
    if (!alvo || !alvoISO) return;
    setEnviando(true);
    try {
      if (alvoDesativado) {
        await reativarDia(alvoISO);
        toast.success(`Rotinas de ${fmtDataCurta.format(alvo)} reativadas.`);
      } else {
        await desativarDia(alvoISO, session?.user.id ?? null);
        toast.success(`Rotinas de ${fmtDataCurta.format(alvo)} desativadas.`);
      }
      queryClient.invalidateQueries({ queryKey: DIAS_DESATIVADOS_QUERY_KEY });
      setAlvo(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível atualizar.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <Popover open={aberto} onOpenChange={setAberto}>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            variant="outline"
            aria-label="Personalizar dias sem expediente"
            title="Personalizar dias sem expediente"
          >
            <CalendarCog className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto p-0">
          <div className="border-b border-border px-3 py-2.5">
            <p className="text-sm font-medium">Programar dias sem expediente</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Escolha uma data para desativar as rotinas. Dias já desativados aparecem destacados —
              selecione de novo para reativar.
            </p>
          </div>
          <Calendar
            mode="single"
            selected={undefined}
            month={mes}
            onMonthChange={setMes}
            onSelect={escolherDia}
            disabled={{ before: hoje }}
            modifiers={{ desativado: diasDesativados }}
            modifiersClassNames={{
              desativado: "bg-chart-4/15 text-chart-4 rounded-md aria-selected:bg-chart-4/15",
            }}
          />
          <div className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-chart-4" />
            Dia sem expediente
          </div>
        </PopoverContent>
      </Popover>

      <AlertDialog open={!!alvo} onOpenChange={(o) => !o && setAlvo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {alvoDesativado
                ? "Reativar as rotinas deste dia?"
                : "Desativar as rotinas deste dia?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {alvo && (
                <span className="font-medium capitalize">{fmtDataExtenso.format(alvo)}</span>
              )}
              {". "}
              {alvoDesativado
                ? "As rotinas desse dia voltam a ser cobradas no painel e no histórico."
                : "Nesse dia as rotinas não serão cobradas no painel nem no histórico. Nenhuma checklist é apagada — você pode reativar quando quiser."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={enviando}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmar} disabled={enviando}>
              {alvoDesativado ? "Reativar" : "Desativar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Faixa no topo do dashboard (admin) para pausar/retomar as rotinas do dia —
 * usada em feriados e dias sem expediente. Desativar pede confirmação; enquanto
 * o dia está pausado, o dashboard zera as pendências e o botão vira "Reativar".
 * Nenhuma checklist é alterada — só a data entra/sai de `dias_desativados`.
 */
function PausaRotinasHoje({ hojeISO, desativado }: { hojeISO: string; desativado: boolean }) {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const [enviando, setEnviando] = React.useState(false);

  async function alternar(reativar: boolean) {
    setEnviando(true);
    try {
      if (reativar) {
        await reativarDia(hojeISO);
        toast.success("Rotinas de hoje reativadas.");
      } else {
        await desativarDia(hojeISO, session?.user.id ?? null);
        toast.success("Rotinas de hoje desativadas.");
      }
      queryClient.invalidateQueries({ queryKey: DIAS_DESATIVADOS_QUERY_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível atualizar.");
    } finally {
      setEnviando(false);
    }
  }

  if (desativado) {
    return (
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-chart-4/30 bg-chart-4/10 p-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-chart-4/20 text-chart-4">
            <CalendarOff className="size-4.5" />
          </span>
          <div>
            <p className="text-sm font-semibold">Rotinas de hoje desativadas</p>
            <p className="text-xs text-muted-foreground">
              As pendências do dia não estão sendo cobradas. Reative quando o expediente voltar ao
              normal.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={enviando} onClick={() => alternar(true)}>
            {enviando ? "Reativando…" : "Reativar rotinas de hoje"}
          </Button>
          <PersonalizarRotinas />
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <CalendarCheck className="size-4.5" />
        </span>
        <div>
          <p className="text-sm font-semibold">Rotinas de hoje ativas</p>
          <p className="text-xs text-muted-foreground">
            Em feriados ou dias sem expediente, desative para não cobrar as pendências do dia.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="outline" disabled={enviando}>
              Desativar rotinas de hoje
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Deseja realmente desativar as rotinas de hoje?</AlertDialogTitle>
              <AlertDialogDescription>
                As rotinas de hoje deixam de ser cobradas no painel enquanto estiverem desativadas.
                Nenhuma checklist é apagada — você pode reativar a qualquer momento.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction onClick={() => alternar(false)}>Desativar</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <PersonalizarRotinas />
      </div>
    </section>
  );
}

function Dashboard() {
  const { checklists: todasChecklists, isLoading, isError } = useGCheck();
  const { session, isAdmin, temAcesso, profile } = useAuth();
  const { hojeISO, hojeDesativado } = useHojeDesativado();
  const { secao } = Route.useSearch();
  const navigate = Route.useNavigate();

  // "Ver todas as rotinas" (não só as próprias) vale para admin e para quem
  // tem a permissão de consultar OU de marcar as checklists dos demais (pra
  // marcar item alheio dá pra ver a rotina inteira, não só a lista das suas).
  const podeVerTodas =
    isAdmin || temAcesso("consultar_checklists_outros") || temAcesso("marcar_checklists_outros");

  // Nomes das contas admin — mesma regra de /checklists: personalizado com
  // acesso amplo (não-admin) não vê rotina cujo responsável é um admin.
  const nomesAdminQuery = useQuery({
    queryKey: NOMES_ADMIN_QUERY_KEY,
    queryFn: fetchNomesAdmin,
    enabled: !!session && podeVerTodas && !isAdmin,
  });
  const nomesAdminSet = React.useMemo(
    () => new Set((nomesAdminQuery.data ?? []).map((n) => n.trim().toLowerCase())),
    [nomesAdminQuery.data],
  );
  const checklists =
    podeVerTodas && !isAdmin
      ? todasChecklists.filter((c) => !nomesAdminSet.has(c.responsavel.trim().toLowerCase()))
      : todasChecklists;
  const podePausar = temAcesso("pausar_dias");
  // "Minhas" só existe pra quem também enxerga o resumo completo — troca o
  // dashboard pelo mesmo recorte que um funcionário comum vê (só as próprias
  // tarefas). Mesma aba de /checklists.
  const verMinhas = podeVerTodas && secao === "minhas";
  const selecionarSecao = React.useCallback(
    (proxima: "minhas" | undefined) => {
      navigate({ search: (prev) => ({ ...prev, secao: proxima }) });
    },
    [navigate],
  );

  const subtitle =
    podeVerTodas && !verMinhas
      ? "Resumo do dia — Loja Matriz"
      : `Tarefas atribuídas a ${profile?.nome ?? "você"}`;

  if (isLoading) {
    return (
      <AppShell title="Dashboard" subtitle={subtitle}>
        <p className="text-sm text-muted-foreground">Carregando rotinas…</p>
      </AppShell>
    );
  }

  if (isError) {
    return (
      <AppShell title="Dashboard" subtitle={subtitle}>
        <p className="text-sm text-destructive">Não foi possível carregar as rotinas.</p>
      </AppShell>
    );
  }

  // Só entram no painel de hoje as rotinas ativas com alguma atividade programada
  // para hoje. A recorrência vive por item, então cada rotina é recortada para as
  // atividades de hoje; as demais contam como "desativadas hoje". Rotina de
  // folga hoje (diasPausados) fica sem nenhum item, como as globalmente pausadas.
  const hoje = new Date();
  const ativas = checklists.filter((c) => c.ativo);
  const rotinasDeHoje = ativas
    .map((c) => {
      // Rotina com corteDia (turno que atravessa a meia-noite) ainda conta
      // como o dia anterior até o corte passar — ver diaOperacionalChecklist.
      const diaOp = diaOperacionalChecklist(c, hoje);
      return {
        ...c,
        itens: checklistPausadaNoDia(c, diaOp)
          ? []
          : c.itens.filter((i) => itemRodaNoDia(i, diaOp)),
      };
    })
    .filter((c) => c.itens.length > 0);
  const inativas = checklists.length - ativas.length;
  // Admin (e quem pode consultar as checklists dos demais) vê todas as rotinas
  // de hoje por inteiro — a não ser que tenha escolhido a aba "Minhas".
  // Funcionário comum (ou quem está em "Minhas") só vê as rotinas de que é
  // responsável (a rotina inteira, não item a item).
  const doDia: Checklist[] =
    podeVerTodas && !verMinhas
      ? rotinasDeHoje
      : rotinasDeHoje.filter((c) => ehResponsavel(c, profile?.nome));
  // Dia pausado (feriado): nada é cobrado hoje — o dashboard calcula como se não
  // houvesse rotina ativa. Ver PausaRotinasHoje / tabela dias_desativados.
  const visiveis: Checklist[] = hojeDesativado ? [] : doDia;

  const totais = visiveis.reduce(
    (acc, c) => {
      acc.pendentes += progresso(c).pendentes;
      const e = estado(c);
      if (e === "concluido") acc.rotinasConcluidas += 1;
      if (e === "atrasada") acc.rotinasAtrasadas += 1;
      return acc;
    },
    { pendentes: 0, rotinasConcluidas: 0, rotinasAtrasadas: 0 },
  );

  // Só a taxa de execução ignora rotinas ainda "não iniciadas" (nada feito e
  // antes do horário de início): incluí-las derrubaria o índice antes da hora.
  // Pendências, a tabela por funcionário e o resto contam todas as rotinas.
  const taxaBase = visiveis
    .filter((c) => !naoIniciada(c))
    .reduce(
      (acc, c) => {
        const p = progresso(c);
        acc.itens += p.total;
        acc.feitos += p.feitos;
        return acc;
      },
      { itens: 0, feitos: 0 },
    );
  const taxa = taxaBase.itens ? Math.round((taxaBase.feitos / taxaBase.itens) * 100) : 0;
  // Destaca itens de rotinas que já estão sendo cobradas: "pendente" (no
  // horário, nada feito), "em andamento" ou "atrasada". Fica de fora o que
  // ainda não iniciou (antes da hora) e o que foi concluído.
  const pendencias = visiveis
    .filter((c) => !naoIniciada(c) && estado(c) !== "concluido")
    .flatMap((c) => c.itens.filter((i) => i.status === "pendente").map((i) => ({ c, i })))
    .slice(0, 6);
  const tudoConcluido = visiveis.length > 0 && visiveis.every((c) => estado(c) === "concluido");

  // Distribuição das tarefas (itens) por responsável — só faz sentido em
  // "Todas", que enxerga todas as checklists ativas.
  const porFuncionario =
    podeVerTodas && !verMinhas && !hojeDesativado ? tarefasPorFuncionario(rotinasDeHoje) : [];

  return (
    <AppShell title="Dashboard" subtitle={subtitle}>
      <div className="mx-auto max-w-5xl space-y-6">
        {podePausar ? (
          <PausaRotinasHoje hojeISO={hojeISO} desativado={hojeDesativado} />
        ) : (
          hojeDesativado && (
            <section className="flex items-center gap-3 rounded-2xl border border-chart-4/30 bg-chart-4/10 p-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-chart-4/20 text-chart-4">
                <CalendarOff className="size-4.5" />
              </span>
              <p className="text-sm">
                As rotinas de hoje foram pausadas pelo administrador (feriado ou dia sem
                expediente).
              </p>
            </section>
          )
        )}

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
              <ListChecks className="size-4" /> Minhas tarefas
            </ToggleGroupItem>
          </ToggleGroup>
        )}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Metric
            label="Pendências"
            value={String(totais.pendentes)}
            hint={hojeDesativado ? "rotinas pausadas hoje" : "itens aguardando execução"}
            icon={AlertCircle}
            tone="warn"
            search={{ estados: ["nao_iniciada", "pendente", "em_andamento", "atrasada"] }}
          />
          <Metric
            label="Rotinas atrasadas"
            value={String(totais.rotinasAtrasadas)}
            hint={
              hojeDesativado
                ? "rotinas pausadas hoje"
                : totais.rotinasAtrasadas > 0
                  ? "passaram do tempo limite"
                  : "dentro do tempo limite"
            }
            icon={AlertTriangle}
            tone="danger"
            search={{ estados: ["atrasada"] }}
          />
          <Metric
            label="Checklists concluídos"
            value={`${totais.rotinasConcluidas}/${visiveis.length}`}
            hint="rotinas finalizadas hoje"
            icon={CheckCircle2}
            tone="success"
            search={{ estados: ["concluido"] }}
          />
          <Metric
            label="Taxa de execução"
            value={`${taxa}%`}
            hint={`${taxaBase.feitos} de ${taxaBase.itens} itens`}
            icon={TrendingUp}
            tone="info"
          />
          <Metric
            label="Rotinas de hoje"
            value={String(visiveis.length)}
            hint={
              podeVerTodas && !verMinhas && ativas.length - rotinasDeHoje.length > 0
                ? `${ativas.length - rotinasDeHoje.length} não programada${
                    ativas.length - rotinasDeHoje.length > 1 ? "s" : ""
                  } para hoje`
                : podeVerTodas && !verMinhas && inativas > 0
                  ? `${inativas} rotina${inativas > 1 ? "s" : ""} inativa${inativas > 1 ? "s" : ""}`
                  : "turnos manhã, tarde e noite"
            }
            icon={ListChecks}
            tone="neutral"
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-5">
          <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm lg:col-span-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="truncate text-base font-semibold tracking-tight">
                Progresso por rotina
              </h2>
              <Button asChild size="sm" variant="outline" className="shrink-0">
                <Link to="/checklists">Ver checklists</Link>
              </Button>
            </div>
            <ul className="mt-4 space-y-4">
              {visiveis.map((c) => {
                const p = progresso(c);
                const e = estado(c);
                return (
                  <li key={c.id} className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{c.nome}</p>
                        <p className="truncate text-xs text-muted-foreground">
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
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          "shrink-0 border-transparent",
                          e === "concluido" && "bg-success/15 text-success",
                          e === "em_andamento" && "bg-chart-4/20 text-chart-4",
                          e === "atrasada" && "bg-destructive/15 text-destructive",
                          e === "pendente" && "bg-muted text-muted-foreground",
                        )}
                      >
                        {estadoLabel[e]}
                      </Badge>
                    </div>
                    <Progress value={p.pct} className="h-1.5" />
                  </li>
                );
              })}
              {visiveis.length === 0 && (
                <li className="rounded-xl bg-muted/60 p-4 text-sm text-muted-foreground">
                  {hojeDesativado
                    ? "Rotinas de hoje pausadas — nenhuma cobrança de pendências."
                    : podeVerTodas && !verMinhas
                      ? inativas > 0
                        ? "Nenhuma rotina ativa no momento."
                        : "Nenhuma rotina cadastrada."
                      : "Nenhuma rotina com itens atribuídos a você no momento."}
                </li>
              )}
            </ul>
          </section>

          <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm lg:col-span-2">
            <h2 className="truncate text-base font-semibold tracking-tight">
              Pendências em destaque
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Itens que ainda precisam ser executados hoje.
            </p>
            <ul className="mt-4 space-y-3">
              {pendencias.map(({ c, i }) => (
                <li key={i.id} className="min-w-0">
                  <Link
                    to="/checklists"
                    search={{ checklist: c.id }}
                    className="block rounded-xl bg-muted/60 p-3 transition-colors hover:bg-muted"
                  >
                    <p className="line-clamp-2 text-sm font-medium">{i.titulo}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {c.nome} · {c.responsavel}
                    </p>
                  </Link>
                </li>
              ))}
              {pendencias.length === 0 && visiveis.length > 0 && (
                <li className="rounded-xl bg-primary/10 p-4 text-sm text-primary">
                  {tudoConcluido
                    ? "Todas as rotinas do dia estão concluídas."
                    : "As rotinas de hoje ainda não começaram."}
                </li>
              )}
              {hojeDesativado && (
                <li className="rounded-xl bg-chart-4/10 p-4 text-sm text-chart-4">
                  Rotinas de hoje pausadas. As pendências voltam a ser cobradas ao reativar.
                </li>
              )}
            </ul>
          </section>
        </div>

        {podeVerTodas && !verMinhas && (
          <TarefasBreakdown
            titulo="Tarefas por funcionário"
            descricao="Itens de rotina atribuídos a cada pessoa"
            icon={Users}
            dados={porFuncionario}
            rotuloItem="tarefa"
            vazio="Nenhuma tarefa atribuída nas rotinas ativas."
          />
        )}
      </div>
    </AppShell>
  );
}
