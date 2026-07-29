"use client";

import { type FormEvent, useState, useTransition } from "react";

export function SetPinForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (pin !== confirmPin) {
      setError("El PIN no coincide con la confirmación.");
      return;
    }

    startTransition(async () => {
      const response = await fetch("/api/account/set-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, pin }),
      });

      if (!response.ok) {
        const body: { error?: string } = await response
          .json()
          .catch(() => ({}));
        setError(body.error ?? "No se pudo configurar el PIN.");
        return;
      }

      setCurrentPassword("");
      setPin("");
      setConfirmPin("");
      setSuccess(true);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-4">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        El PIN permite reabrir la app rápidamente en este dispositivo, sin
        volver a teclear la contraseña completa.
      </p>

      <label className="flex flex-col gap-1 text-sm">
        Contraseña actual
        <input
          type="password"
          required
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        PIN (4 dígitos)
        <input
          type="password"
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

      <label className="flex flex-col gap-1 text-sm">
        Confirma el PIN
        <input
          type="password"
          required
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          autoComplete="off"
          value={confirmPin}
          onChange={(event) =>
            setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 4))
          }
          className="rounded-md border border-zinc-300 px-3 py-2 tracking-[0.5em] dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="text-sm text-green-700 dark:text-green-400">
          PIN configurado correctamente.
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="mt-2 rounded-md bg-zinc-900 px-4 py-2 font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {isPending ? "Guardando..." : "Guardar PIN"}
      </button>
    </form>
  );
}
