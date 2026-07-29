"use client";

import { type FormEvent, useState, useTransition } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

type Mode = "password" | "pin";

const ERROR_MESSAGES: Record<string, string> = {
  too_many_attempts:
    "Demasiados intentos. Espera unos minutos antes de volver a intentarlo.",
  default: "Email, contraseña o PIN incorrectos.",
};

function errorMessageFor(code: string | undefined): string {
  return ERROR_MESSAGES[code ?? "default"] ?? ERROR_MESSAGES.default;
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";

  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const result = await signIn(
        mode,
        mode === "password"
          ? { email, password, redirect: false }
          : { email, pin, redirect: false },
      );

      if (!result || result.error) {
        setError(errorMessageFor(result?.code));
        return;
      }

      router.push(callbackUrl);
      router.refresh();
    });
  }

  return (
    <div className="w-full max-w-sm">
      <div
        className="mb-6 flex rounded-lg border border-zinc-300 p-1 text-sm dark:border-zinc-700"
        role="tablist"
        aria-label="Método de acceso"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "password"}
          className={`flex-1 rounded-md px-3 py-2 font-medium transition-colors ${
            mode === "password"
              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
              : "text-zinc-600 dark:text-zinc-400"
          }`}
          onClick={() => {
            setMode("password");
            setError(null);
          }}
        >
          Email y contraseña
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "pin"}
          className={`flex-1 rounded-md px-3 py-2 font-medium transition-colors ${
            mode === "pin"
              ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
              : "text-zinc-600 dark:text-zinc-400"
          }`}
          onClick={() => {
            setMode("pin");
            setError(null);
          }}
        >
          Reabrir con PIN
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>

        {mode === "password" ? (
          <label className="flex flex-col gap-1 text-sm">
            Contraseña
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            PIN (4 dígitos)
            <input
              type="password"
              name="pin"
              required
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              autoComplete="off"
              value={pin}
              onChange={(event) =>
                setPin(event.target.value.replace(/\D/g, "").slice(0, 4))
              }
              className="rounded-md border border-zinc-300 px-3 py-2 tracking-[0.5em] dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        )}

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isPending}
          className="mt-2 rounded-md bg-zinc-900 px-4 py-2 font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {isPending
            ? "Comprobando..."
            : mode === "password"
              ? "Iniciar sesión"
              : "Desbloquear"}
        </button>
      </form>
    </div>
  );
}
