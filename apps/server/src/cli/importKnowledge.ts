// Usage: npm run knowledge:import -- <notes.json>
// Format: docs/KNOWLEDGE_BASE.md. Nothing is imported if any note is invalid.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadDotEnvFile, loadEnv } from "../config/env";
import { openDb } from "../db/client";
import { importKnowledge } from "../services/knowledgeImport";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("Usage: npm run knowledge:import -- <notes.json>");
  process.exit(1);
}

let data: unknown;
try {
  data = JSON.parse(readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), file), "utf8"));
} catch (err) {
  console.error(`Cannot read ${file}: ${(err as Error).message}`);
  process.exit(1);
}

loadDotEnvFile();
const env = loadEnv();
const handle = await openDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
try {
  await handle.migrate();
  const r = await importKnowledge(handle.db, { type: "SYSTEM", id: "knowledge-import" }, data, `Import: ${path.basename(file)}`);
  if (r.errors.length) {
    console.error(`Nothing imported. Fix these and run again:\n- ${r.errors.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Imported ${r.imported} note(s); ${r.skipped} already present.`);
  }
} finally {
  await handle.close();
}
