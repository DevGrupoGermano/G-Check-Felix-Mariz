import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  History,
  LayoutDashboard,
  ListChecks,
  Lock,
  LogOut,
  Menu,
  Store,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-store";

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact: boolean;
};

const navBase: readonly NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/checklists", label: "Checklists", icon: ListChecks, exact: false },
];

// Seção só de admin. As rotas também se autoprotegem (ver historico.tsx /
// funcionarios.tsx), então esconder aqui é só para não oferecer um link que
// levaria a uma tela de acesso negado.
const navAdmin: readonly NavItem[] = [
  { to: "/historico", label: "Histórico", icon: History, exact: false },
];

const navCadastros: readonly NavItem[] = [
  { to: "/funcionarios", label: "Funcionários", icon: Users, exact: false },
];

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: (() => void) | undefined }) {
  const { to, label, icon: Icon, exact } = item;
  return (
    <Link
      to={to}
      onClick={onNavigate}
      activeOptions={{ exact }}
      className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:border-[#FFDA24] hover:bg-[#FFDA24]/10 hover:text-[#FFDA24] data-[status=active]:border-[#FFDA24] data-[status=active]:bg-[#FFDA24]/10 data-[status=active]:font-semibold data-[status=active]:text-[#FFDA24]"
    >
      <Icon className="size-4.5" />
      {label}
    </Link>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { temAcesso } = useAuth();
  const podeHistorico = temAcesso("ver_historico");
  const podeFuncionarios = temAcesso("cadastrar_funcionarios");

  return (
    <nav className="flex flex-col gap-1">
      {navBase.map((item) => (
        <NavLink key={item.to} item={item} onNavigate={onNavigate} />
      ))}

      {podeHistorico &&
        navAdmin.map((item) => <NavLink key={item.to} item={item} onNavigate={onNavigate} />)}

      {podeFuncionarios && (
        <>
          <p className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Rotina de cadastros
          </p>
          {navCadastros.map((item) => (
            <NavLink key={item.to} item={item} onNavigate={onNavigate} />
          ))}
        </>
      )}
    </nav>
  );
}

// Item de navegação bloqueado (feature futura). Só admin enxerga — funcionário
// nem precisa saber que vai existir um módulo financeiro.
function FinanceiroLocked() {
  const { isAdmin } = useAuth();
  if (!isAdmin) return null;

  return (
    <div
      title="Em breve"
      aria-disabled="true"
      className="flex cursor-not-allowed items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-sm font-medium text-sidebar-foreground/40"
    >
      <Wallet className="size-4.5" />
      Financeiro
      <Lock className="ml-auto size-3.5" />
    </div>
  );
}

function UserFooter() {
  const { signOut } = useAuth();

  async function handleSignOut() {
    await signOut();
    window.location.assign("/login");
  }

  return (
    <button
      onClick={handleSignOut}
      className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:border-[#FFDA24] hover:bg-[#FFDA24]/10 hover:text-[#FFDA24]"
    >
      <LogOut className="size-4.5" />
      Sair
    </button>
  );
}

function iniciais(nome?: string | null) {
  const partes = (nome ?? "").trim().split(/\s+/).filter(Boolean);
  const primeira = partes[0] ?? "";
  const ultima = partes[partes.length - 1] ?? "";
  if (!primeira) return "?";
  if (partes.length === 1) return primeira.slice(0, 2).toUpperCase();
  return (primeira[0]! + ultima[0]!).toUpperCase();
}

const WHATSAPP_URL =
  "https://wa.me/5519997012163?text=" +
  encodeURIComponent(
    "Olá, preciso de ajuda com o sistema G-Check do supermercado félix, pode me ajudar?",
  );

function WhatsAppButton() {
  return (
    <a
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Falar no WhatsApp"
      className="fixed bottom-5 right-5 z-50 flex size-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg transition-transform hover:scale-105 hover:shadow-xl"
    >
      <svg viewBox="0 0 32 32" className="size-7" fill="currentColor" aria-hidden="true">
        <path d="M16.004 3C9.377 3 4 8.377 4 15.004c0 2.32.646 4.556 1.87 6.51L4 29l7.66-1.84a11.94 11.94 0 0 0 4.344.834h.005c6.627 0 12.004-5.377 12.004-12.004C28.013 8.377 22.636 3 16.004 3Zm0 21.84h-.004a9.9 9.9 0 0 1-5.05-1.383l-.362-.215-3.79.91.897-3.696-.235-.379a9.87 9.87 0 0 1-1.515-5.269c0-5.478 4.457-9.935 9.94-9.935 2.655 0 5.15 1.035 7.026 2.914a9.87 9.87 0 0 1 2.912 7.027c0 5.478-4.457 9.935-9.819 9.935Zm5.44-7.44c-.298-.15-1.764-.87-2.037-.97-.273-.1-.47-.15-.669.15-.198.298-.767.97-.94 1.169-.174.199-.348.224-.646.075-.298-.15-1.258-.464-2.396-1.48-.886-.79-1.484-1.767-1.658-2.065-.174-.298-.019-.46.13-.609.134-.133.298-.348.447-.522.15-.174.199-.298.298-.497.1-.199.05-.373-.025-.522-.075-.15-.669-1.612-.916-2.208-.242-.58-.487-.502-.669-.512l-.57-.01c-.198 0-.522.075-.795.373-.273.298-1.04 1.017-1.04 2.48 0 1.462 1.065 2.876 1.213 3.075.15.199 2.096 3.2 5.078 4.487.71.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.764-.72 2.013-1.416.248-.696.248-1.293.174-1.417-.075-.124-.273-.199-.571-.348Z" />
      </svg>
    </a>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <span className="flex size-9 items-center justify-center rounded-xl bg-white/15 text-white">
        <Store className="size-5" />
      </span>
      <span className="leading-tight">
        <span className="block text-base font-semibold tracking-tight text-sidebar-foreground">
          G-check
        </span>
        <span className="block text-xs text-sidebar-foreground/60">Controle de Rotinas</span>
      </span>
    </div>
  );
}

export function AppShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const { profile } = useAuth();

  return (
    <div className="min-h-screen bg-background lg:flex">
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:gap-6 lg:overflow-y-auto lg:p-4">
        <Brand />
        <NavLinks />
        <div className="mt-auto flex flex-col gap-1">
          <FinanceiroLocked />
          <UserFooter />
        </div>
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            aria-label="Fechar menu"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setOpen(false)}
          />
          <div className="relative flex h-full w-68 flex-col gap-6 border-r border-sidebar-border bg-sidebar p-4 text-sidebar-foreground">
            <div className="flex items-center justify-between">
              <Brand />
              <button onClick={() => setOpen(false)} aria-label="Fechar menu">
                <X className="size-5 text-white/80" />
              </button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
            <div className="mt-auto flex flex-col gap-1">
              <FinanceiroLocked />
              <UserFooter />
            </div>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-2.5 border-b border-black/10 bg-[#FFDA24] px-4 py-2.5 text-neutral-900 md:px-6">
          <button className="lg:hidden" onClick={() => setOpen(true)} aria-label="Abrir menu">
            <Menu className="size-4.5" />
          </button>
          <img
            src="/logo-felix.png"
            alt="Felix Matriz"
            className="h-10 w-auto shrink-0 md:h-12"
          />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight md:text-lg">{title}</h1>
            {subtitle && <p className="truncate text-xs text-neutral-800/80">{subtitle}</p>}
          </div>
          <span
            title={profile?.nome ?? undefined}
            className="ml-auto flex size-8 shrink-0 select-none items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground shadow"
          >
            {iniciais(profile?.nome)}
          </span>
        </header>
        <main className={cn("flex-1 bg-[#FBF7EE] px-4 py-6 text-neutral-900 md:px-8 md:py-8")}>
          {children}
        </main>
      </div>

      <WhatsAppButton />
    </div>
  );
}
