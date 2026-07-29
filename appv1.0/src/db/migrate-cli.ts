import "dotenv/config";
import { runMigrations } from "./migrate";

runMigrations()
  .then(() => {
    console.log("✅ Migraciones aplicadas.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("❌ Error al aplicar migraciones:", error);
    process.exit(1);
  });
