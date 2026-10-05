import { describe, expect, it } from "vitest";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { CONFIG_DIR } from "../test/helpers";
import { classifyStages, stageFromFilename, stagesFromTimes, type StageInput } from "./stageClassification";

const t = loadVerificationConfigFromDir(CONFIG_DIR).thresholds.pairing;
const at = (hhmm: string) => new Date(`2026-10-04T${hhmm}:00Z`);
const input = (imageId: string, filename: string | null, time: string | null): StageInput => ({
  imageId,
  filename,
  capturedAt: time ? at(time) : null,
});

describe("stageFromFilename", () => {
  it.each([
    ["front_lawn_before_001.jpg", "BEFORE"],
    ["Front Lawn - BEFORE.HEIC", "BEFORE"],
    ["pre-service-2.jpg", "BEFORE"],
    ["lawn_after_002.jpg", "AFTER"],
    ["post.jpg", "AFTER"],
    ["job-complete.png", "AFTER"],
    ["crew_progress_12.jpg", "DURING"],
  ])("%s → %s", (name, stage) => {
    expect(stageFromFilename(name)).toBe(stage);
  });

  it.each(["IMG_1234.jpg", "before_and_after.jpg", "prepared.jpg", "afterglow.jpg", null])("%s → no signal", (name) => {
    expect(stageFromFilename(name)).toBeNull();
  });
});

describe("stagesFromTimes", () => {
  it("splits a visit with one dominant gap into before/after", () => {
    const r = stagesFromTimes([input("a", null, "08:00"), input("b", null, "08:03"), input("c", null, "11:00"), input("d", null, "11:05")], t);
    expect(Object.fromEntries(r)).toEqual({ a: "BEFORE", b: "BEFORE", c: "AFTER", d: "AFTER" });
  });

  it("gives no signal when photos were taken continuously", () => {
    expect(stagesFromTimes([input("a", null, "08:00"), input("b", null, "08:10"), input("c", null, "08:20")], t).size).toBe(0);
  });

  it("gives no signal for interleaved before/after shooting (no dominant gap)", () => {
    const r = stagesFromTimes(
      [input("a1", null, "08:00"), input("a2", null, "09:00"), input("b1", null, "09:05"), input("b2", null, "10:00")],
      t,
    );
    expect(r.size).toBe(0);
  });

  it("gives no signal without at least two timestamps", () => {
    expect(stagesFromTimes([input("a", null, "08:00"), input("b", null, null)], t).size).toBe(0);
  });
});

describe("classifyStages", () => {
  it("is STRONG when filename and time agree", () => {
    const r = classifyStages([input("a", "lawn_before.jpg", "08:00"), input("b", "lawn_after.jpg", "11:00")], t);
    expect(r.get("a")).toMatchObject({ stage: "BEFORE", certainty: "STRONG" });
    expect(r.get("b")).toMatchObject({ stage: "AFTER", certainty: "STRONG" });
  });

  it("becomes UNKNOWN when filename and time disagree", () => {
    const r = classifyStages([input("a", "lawn_after.jpg", "08:00"), input("b", "lawn_after.jpg", "11:00")], t);
    expect(r.get("a")).toMatchObject({ stage: "UNKNOWN", signals: { conflict: true } });
  });

  it("uses a single signal when only one is available", () => {
    const r = classifyStages([input("a", "IMG_1.jpg", "08:00"), input("b", "IMG_2.jpg", "11:00"), input("c", "x_before.jpg", null)], t);
    expect(r.get("a")).toMatchObject({ stage: "BEFORE", certainty: "SINGLE" });
    expect(r.get("c")).toMatchObject({ stage: "BEFORE", certainty: "SINGLE" });
  });

  it("is UNKNOWN with no signal — upload order is never used", () => {
    const r = classifyStages([input("a", "IMG_1.jpg", null), input("b", "IMG_2.jpg", null)], t);
    expect([...r.values()].every((x) => x.stage === "UNKNOWN")).toBe(true);
  });

  it("keeps in-progress photos out of before/after", () => {
    expect(classifyStages([input("a", "crew_progress.jpg", "10:00")], t).get("a")!.stage).toBe("DURING");
  });
});
