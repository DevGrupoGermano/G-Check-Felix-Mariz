# G-Check-Felix-Matriz

Versão do **G-Check** personalizada para o cliente **Felix Matriz**.

G-Check é um app web de rotinas e checklists operacionais para supermercados:
Dashboard com visão de pendências, checklists concluídos e taxa de execução,
e gestão de rotinas (abertura de loja, reposição de gôndolas, controle de
validade, limpeza e fechamento) com abertura/conclusão de itens.

## Stack

- [TanStack Start](https://tanstack.com/start) + React 19 + Vite
- Tailwind CSS 4 + Radix UI
- Supabase (banco e migrations em `supabase/`)
- Runtime/gerenciador de pacotes: [Bun](https://bun.sh)

## Desenvolvimento

```sh
bun install   # ou: npm install
bun run dev   # ou: npm run dev
```

O app sobe em **http://localhost:3100** (host e porta fixos no `vite.config.ts`,
dev e preview). A porta é 3100 para não colidir com outros projetos locais.

Outros scripts:

| Comando            | Descrição                        |
| ------------------ | -------------------------------- |
| `bun run build`    | Build de produção                |
| `bun run preview`  | Servir o build localmente        |
| `bun run lint`     | ESLint                           |
| `bun run format`   | Prettier                         |

> Em pasta sincronizada pelo OneDrive o `bun install` pode não materializar o
> `node_modules` (bug conhecido). Se acontecer, use `npm install`
> (`package-lock.json` fica fora do Git; o lockfile canônico é o `bun.lock`).

## Banco de dados

Migration única de baseline em `supabase/migrations/20260902120000_init.sql`:
cria todo o schema (tabelas, funções, triggers, RLS, storage bucket) e o único
login inicial `admin@felixmatriz.com` / `Admin@2026` (papel admin). O banco
começa sem dados de demonstração.

Projeto novo (vazio): rode esse arquivo uma vez no SQL Editor do Supabase, ou
`supabase db push` com o CLI. Os demais funcionários são cadastrados pelo app,
logado como admin, na tela de Funcionários.

`supabase/full_setup.sql` é material antigo do G-Check e não deve ser usado
neste projeto.

## Configuração

Crie um arquivo `.env` na raiz (já no `.gitignore`):

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```
