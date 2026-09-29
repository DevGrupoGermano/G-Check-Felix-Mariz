import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth-store";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [{ title: "Entrar — G-check" }],
  }),
  component: LoginPage,
});

// Paleta da tela de login (cliente Felix Matriz):
// - fundo: amarelo mostarda um pouco claro
// - caixa do formulário: vermelho um pouco mais forte e escuro
const COR_FUNDO = "#FFDA24";
const COR_FORM = "#BF2020";

const loginSchema = z.object({
  email: z.string().trim().min(1, "Informe o e-mail.").email("E-mail inválido."),
  senha: z.string().min(1, "Informe a senha."),
});

type LoginValues = z.infer<typeof loginSchema>;

function LoginPage() {
  const { signIn } = useAuth();
  const [erro, setErro] = React.useState<string | null>(null);
  const [enviando, setEnviando] = React.useState(false);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", senha: "" },
  });

  async function onSubmit(values: LoginValues) {
    setErro(null);
    setEnviando(true);
    const { error } = await signIn(values.email, values.senha);
    setEnviando(false);
    if (error) {
      // Mostra a mensagem real do Supabase para facilitar o diagnóstico
      // (credenciais inválidas, e-mail não confirmado, projeto errado, etc.).
      setErro(error);
    }
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4 py-10"
      style={{ backgroundColor: COR_FUNDO }}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        {/* Logo do cliente, acima e fora do formulário. */}
        <img
          src="/logo-felix.png"
          alt="Felix Matriz"
          className="h-36 w-auto drop-shadow-sm"
        />

        <div
          className="w-full rounded-2xl p-6 text-white shadow-lg"
          style={{ backgroundColor: COR_FORM }}
        >
          <div className="mb-5 text-center">
            <h1 className="text-lg font-semibold tracking-tight">G-check</h1>
            <p className="text-sm text-white/80">Entre para acessar as rotinas da loja.</p>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-white">E-mail</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="voce@empresa.com"
                        className="border-transparent bg-white text-neutral-900 placeholder:text-neutral-400"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-yellow-200" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="senha"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-white">Senha</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder="••••••••"
                        className="border-transparent bg-white text-neutral-900 placeholder:text-neutral-400"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-yellow-200" />
                  </FormItem>
                )}
              />

              {erro && <p className="text-sm font-medium text-yellow-200">{erro}</p>}

              <Button
                type="submit"
                className="w-full bg-white text-[#BF2020] hover:bg-white/90"
                disabled={enviando}
              >
                {enviando ? "Entrando…" : "Entrar"}
              </Button>
            </form>
          </Form>

          <p className="mt-4 text-center text-xs text-white/75">
            Sem acesso? Fale com o administrador da sua loja.
          </p>
        </div>

        {/* Logo G-tech, abaixo e fora do formulário. */}
        <img src="/logo-gtech.png" alt="G-tech" className="h-28 w-auto opacity-90" />
      </div>
    </div>
  );
}
