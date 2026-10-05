import type { FastifyInstance } from "fastify";
import { requireRole, requireUser } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { loadActiveConfig } from "../../config/configStore";

export async function configRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Service registry — reviewers need it to read assessments. */
  app.get("/api/services", { preHandler: requireUser }, async () => {
    const cfg = await loadActiveConfig(ctx.db);
    return {
      version: cfg.registry.version,
      services: cfg.registry.list().map((s) => ({
        code: s.code,
        displayName: s.display_name,
        description: s.description,
        requiresBeforeAfter: s.requires_before_after,
        defaultHumanReview: s.default_human_review,
        safetyNotes: s.safety_notes,
      })),
    };
  });

  /** Clients with their active profile version. Full rules are Team Lead+. */
  app.get("/api/clients", { preHandler: requireUser }, async (req) => {
    const cfg = await loadActiveConfig(ctx.db);
    const detailed = req.user!.role !== "REVIEWER";
    return {
      clients: [...cfg.clientProfiles.entries()].map(([code, p]) => ({
        code,
        displayName: p.profile.display_name,
        profileVersion: p.version,
        requiredServices: p.profile.required_services,
        provisional: p.profile.provisional,
        ...(detailed ? { profile: p.profile } : {}),
      })),
    };
  });

  /** Active thresholds — always flagged when provisional (PRD §24, plan A7). */
  app.get("/api/config/thresholds", { preHandler: requireRole("TEAM_LEAD") }, async () => {
    const cfg = await loadActiveConfig(ctx.db);
    return { thresholds: cfg.thresholds };
  });

  app.get("/api/config/runtime", { preHandler: requireRole("TEAM_LEAD") }, async () => ({
    automationLevel: ctx.env.AUTOMATION_LEVEL,
    shadowMode: ctx.env.SHADOW_MODE,
    mocks: {
      netsuite: ctx.env.MOCK_NETSUITE,
      ai: ctx.env.MOCK_AI,
      images: ctx.env.MOCK_IMAGES,
    },
    appVersion: ctx.env.APP_VERSION,
  }));
}
