import { describe, expect, it } from "vitest";
import { ConfigError, loadEnv } from "./env";

describe("loadEnv", () => {
  it("defaults to mock mode and automation level 1 locally", () => {
    const env = loadEnv({});
    expect(env.MOCK_NETSUITE && env.MOCK_AI && env.MOCK_IMAGES).toBe(true);
    expect(env.AUTOMATION_LEVEL).toBe(1);
    expect(env.SHADOW_MODE).toBe(false);
  });

  it.each(["4", "5"])("refuses AUTOMATION_LEVEL=%s", (level) => {
    expect(() => loadEnv({ AUTOMATION_LEVEL: level })).toThrow(ConfigError);
  });

  it("accepts levels 0–3", () => {
    for (const l of ["0", "1", "2", "3"]) expect(loadEnv({ AUTOMATION_LEVEL: l }).AUTOMATION_LEVEL).toBe(Number(l));
  });

  const prod = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://u:p@db:5432/alvip",
    MOCK_NETSUITE: "false",
    MOCK_AI: "false",
    MOCK_IMAGES: "false",
  };

  it("accepts a valid production config", () => {
    expect(() => loadEnv(prod)).not.toThrow();
  });

  it("refuses mocks in production", () => {
    expect(() => loadEnv({ ...prod, MOCK_AI: "true" })).toThrow(/MOCK_AI/);
  });

  it("requires a real database in production", () => {
    const { DATABASE_URL: _omit, ...noDb } = prod;
    expect(() => loadEnv(noDb)).toThrow(/DATABASE_URL/);
  });

  it("requires secure cookies in production", () => {
    expect(() => loadEnv({ ...prod, COOKIE_SECURE: "false" })).toThrow(/COOKIE_SECURE/);
  });

  it("treats empty strings as unset", () => {
    expect(loadEnv({ NETSUITE_API_BASE_URL: "", PORT: "" }).PORT).toBe(3000);
  });
});
