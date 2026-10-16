import * as React from "react";
import { Camera, Check, Loader2, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Lado maior de uma foto capturada, em pixels — reduz o tamanho do upload
 *  sem perda perceptível para documentar um checklist. */
const FOTO_LADO_MAX_PX = 1600;
const FOTO_QUALIDADE = 0.7;

type Estado = "abrindo" | "pronta" | "revisando" | "erro";

interface Capturado {
  file: File;
  url: string;
}

function mensagemErro(err: unknown): string {
  const nome = err instanceof DOMException ? err.name : "";
  if (nome === "NotAllowedError" || nome === "PermissionDeniedError") {
    return "Permissão da câmera negada — habilite o acesso à câmera nas configurações do navegador e tente de novo.";
  }
  if (nome === "NotFoundError" || nome === "DevicesNotFoundError") {
    return "Nenhuma câmera encontrada neste dispositivo.";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "Este navegador (ou a conexão, se não for https) não dá acesso à câmera.";
  }
  return "Não foi possível abrir a câmera. Tente de novo.";
}

/**
 * Captura foto direto na página (getUserMedia), sem abrir o app de câmera do
 * celular. Existe porque o `<input capture>` faz o navegador jogar a aba pra
 * segundo plano enquanto usa a câmera nativa — em celulares com pouca RAM o
 * sistema às vezes descarta a aba nesse meio tempo, perdendo o arquivo e sem
 * sinal nenhum de erro pro usuário. Ficando na própria página, a aba nunca sai
 * de primeiro plano. Gravação de vídeo foi removida de propósito — consumia o
 * storage do Supabase rápido demais.
 */
export function CapturaCameraDialog({
  open,
  onOpenChange,
  onCapturar,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCapturar: (arquivo: File) => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);

  const [estado, setEstado] = React.useState<Estado>("abrindo");
  const [erro, setErro] = React.useState("");
  const [capturado, setCapturado] = React.useState<Capturado | null>(null);

  const pararStream = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // `.play()` explícito porque em vários celulares o atributo `autoPlay`
  // sozinho não garante que o preview comece a tocar quando o `srcObject` é
  // setado via JS — daí o preview ficar preto mesmo com o stream já vivo.
  function anexarStreamNoVideo(stream: MediaStream) {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {
      /* alguns navegadores rejeitam se o usuário já saiu da tela — sem problema */
    });
  }

  React.useEffect(() => {
    if (!open) return;
    let vivo = true;
    setEstado("abrindo");
    setErro("");
    setCapturado(null);
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((stream) => {
        if (!vivo) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        anexarStreamNoVideo(stream);
        setEstado("pronta");
      })
      .catch((err: unknown) => {
        if (!vivo) return;
        setErro(mensagemErro(err));
        setEstado("erro");
      });
    return () => {
      vivo = false;
      pararStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Solta a URL do preview anterior pra não vazar memória entre capturas.
  React.useEffect(() => {
    return () => {
      if (capturado) URL.revokeObjectURL(capturado.url);
    };
  }, [capturado]);

  function fechar() {
    onOpenChange(false);
  }

  function tirarFoto() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const largura = video.videoWidth;
    const altura = video.videoHeight;
    const escala = Math.min(1, FOTO_LADO_MAX_PX / Math.max(largura, altura));
    canvas.width = Math.round(largura * escala);
    canvas.height = Math.round(altura * escala);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        pararStream();
        setCapturado({
          file: new File([blob], `foto-${Date.now()}.jpg`, { type: "image/jpeg" }),
          url: URL.createObjectURL(blob),
        });
        setEstado("revisando");
      },
      "image/jpeg",
      FOTO_QUALIDADE,
    );
  }

  function refazer() {
    if (capturado) URL.revokeObjectURL(capturado.url);
    setCapturado(null);
    // Reabre a câmera do zero.
    setEstado("abrindo");
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((stream) => {
        streamRef.current = stream;
        anexarStreamNoVideo(stream);
        setEstado("pronta");
      })
      .catch((err: unknown) => {
        setErro(mensagemErro(err));
        setEstado("erro");
      });
  }

  function usar() {
    if (!capturado) return;
    onCapturar(capturado.file);
    fechar();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && fechar()}>
      <DialogContent className="flex max-w-lg flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Tirar foto</DialogTitle>
        </DialogHeader>

        <div className="relative flex min-h-64 items-center justify-center overflow-hidden rounded-lg bg-black">
          {estado === "abrindo" && <Loader2 className="size-8 animate-spin text-white/80" />}
          {estado === "erro" && (
            <p className="max-w-xs px-4 text-center text-sm text-white/90">{erro}</p>
          )}
          {/* Sempre montado (não condicional) — a ref precisa existir antes do
              stream chegar, senão o srcObject nunca é anexado a um elemento
              real e o preview fica preto mesmo com a câmera funcionando. */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={estado === "pronta" ? "max-h-[60vh] w-full object-contain" : "hidden"}
          />
          {estado === "revisando" && capturado && (
            <img
              src={capturado.url}
              className="max-h-[60vh] w-full object-contain"
              alt="Foto capturada"
            />
          )}
        </div>
        <canvas ref={canvasRef} hidden />

        <div className="flex justify-end gap-2">
          {estado === "revisando" ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={refazer}
              >
                <RotateCcw className="size-4" />
                Refazer
              </Button>
              <Button type="button" size="sm" className="gap-1.5" onClick={usar}>
                <Check className="size-4" />
                Usar
              </Button>
            </>
          ) : estado === "pronta" ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={fechar}
              >
                <X className="size-4" />
                Cancelar
              </Button>
              <Button type="button" size="sm" className="gap-1.5" onClick={tirarFoto}>
                <Camera className="size-4" />
                Capturar
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={fechar}>
              <X className="size-4" />
              Fechar
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
