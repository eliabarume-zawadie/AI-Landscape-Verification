// Usage: npm run golden:import -- <folder with manifest.json and photos>
// Format: docs/AI_EVALUATION.md. Nothing is imported if anything is invalid. Imported examples
// are drafts: a team lead checks and approves each one before evaluations use it.
import path from "node:path";
import { loadDotEnvFile, loadEnv } from "../config/env";
import { openDb } from "../db/client";
import { LocalStorageProvider } from "../integrations/storage/LocalStorageProvider";
import { importGoldenFolder } from "../services/goldenImport";

const [dir] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: npm run golden:import -- <folder>");
  process.exit(1);
}

loadDotEnvFile();
const env = loadEnv();
const handle = await openDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
try {
  await handle.migrate();
  const r = await importGoldenFolder(handle.db, new LocalStorageProvider(env.STORAGE_DIR), { type: "SYSTEM", id: "golden-import" }, path.resolve(process.env.INIT_CWD ?? process.cwd(), dir));
  if (r.errors.length) {
    console.error(`Nothing imported. Fix these and run again:\n- ${r.errors.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Imported ${r.imported} draft example(s). A team lead must approve each one on the Evaluation page.`);
  }
} finally {
  await handle.close();
}
