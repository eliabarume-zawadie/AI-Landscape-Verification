import type { Env } from "../config/env";
import type { Db } from "../db/client";
import type { Integrations } from "../integrations";
import type { QueueProvider } from "../integrations/queue/QueueProvider";
import type { LoginThrottle } from "../services/auth";

/** Dependencies shared by route modules. Built once in main.ts (or per test). */
export interface AppContext {
  env: Env;
  db: Db;
  loginThrottle: LoginThrottle;
  queue: QueueProvider;
  integrations: Integrations;
}
