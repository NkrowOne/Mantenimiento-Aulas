import { expect, test } from "@playwright/test";

test("la página de inicio muestra el título de la aplicación", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Mantenimiento de Aulas y Salas" }),
  ).toBeVisible();
});
