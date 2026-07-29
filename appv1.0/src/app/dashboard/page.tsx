import Link from "next/link";
import { auth } from "@/auth";
import { SignOutButton } from "@/components/layout/SignOutButton";

export default async function DashboardPage() {
  const session = await auth();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Cuadro de mando</h1>
      {session?.user ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          Sesión iniciada como <strong>{session.user.name}</strong> (
          {session.user.email}) — rol <strong>{session.user.role}</strong>
        </p>
      ) : null}
      <p className="text-zinc-600 dark:text-zinc-400">
        Pantalla en construcción.
      </p>
      <div className="flex gap-3 text-sm">
        <Link
          href="/account/change-password"
          className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Cambiar contraseña
        </Link>
        <Link
          href="/account/pin"
          className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Configurar PIN
        </Link>
        <SignOutButton />
      </div>
    </div>
  );
}
