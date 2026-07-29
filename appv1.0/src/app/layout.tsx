import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mantenimiento de Aulas y Salas",
  description:
    "PWA para la gestión de mantenimiento de aulas y salas de reunión.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
