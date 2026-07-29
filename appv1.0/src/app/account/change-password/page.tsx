import { auth } from "@/auth";
import { ChangePasswordForm } from "@/components/forms/ChangePasswordForm";

export default async function ChangePasswordPage() {
  const session = await auth();

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8">
      <h1 className="mb-6 text-2xl font-semibold">Cambiar contraseña</h1>
      <ChangePasswordForm forced={session?.user.mustChangePassword} />
    </div>
  );
}
