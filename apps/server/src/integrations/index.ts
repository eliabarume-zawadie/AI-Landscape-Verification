import { ConfigError, type Env } from "../config/env";
import { MockNetSuiteAdapter } from "./netsuite/mock/MockNetSuiteAdapter";
import type { NetSuiteAdapter } from "./netsuite/NetSuiteAdapter";

export interface Integrations {
  netsuite: NetSuiteAdapter;
}

/**
 * Select adapter implementations from configuration. Production adapters that depend
 * on unknown integration details refuse to start instead of guessing (plan §13).
 */
export function createIntegrations(env: Env): Integrations {
  return { netsuite: createNetSuiteAdapter(env) };
}

function createNetSuiteAdapter(env: Env): NetSuiteAdapter {
  if (env.MOCK_NETSUITE) return new MockNetSuiteAdapter();
  throw new ConfigError(
    "Production NetSuite adapter is not implemented yet: it is blocked on NetSuite record types, " +
      "field IDs, auth method, and image storage details (IMPLEMENTATION_PLAN unknowns U1–U6). " +
      "Set MOCK_NETSUITE=true for development.",
  );
}
