import { SetPinForm } from "@/components/forms/SetPinForm";

export default function SetPinPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8">
      <h1 className="mb-6 text-2xl font-semibold">Configurar PIN</h1>
      <SetPinForm />
    </div>
  );
}
