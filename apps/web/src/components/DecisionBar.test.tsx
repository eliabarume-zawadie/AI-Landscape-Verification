// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WipeCompare } from "./bits";
import { conflictsFor, DecisionBar, type AiView } from "./DecisionBar";

afterEach(cleanup);

const supported: AiView = { recommendation: "RECOMMEND_APPROVE", services: [{ service: "mowing", status: "SUPPORTED", confidence: "HIGH" }] };
const contradictory: AiView = { recommendation: "NEEDS_HUMAN_REVIEW", services: [{ service: "mowing", status: "CONTRADICTORY", confidence: "LOW" }] };

describe("conflictsFor (mirrors the server rule)", () => {
  it("flags approving unsupported services and rejecting strong support", () => {
    expect(conflictsFor("APPROVE", contradictory)).toEqual(["mowing isn't supported by the evidence."]);
    expect(conflictsFor("REJECT", supported)).toHaveLength(2);
    expect(conflictsFor("APPROVE", supported)).toEqual([]);
    expect(conflictsFor("ESCALATE", contradictory)).toEqual([]);
  });
});

describe("DecisionBar", () => {
  const setup = (ai: AiView) => {
    const onDecide = vi.fn();
    const onSkip = vi.fn();
    render(<DecisionBar ai={ai} busy={false} canEscalate serverError={null} onDecide={onDecide} onSkip={onSkip} />);
    return { onDecide, onSkip };
  };

  it("decides immediately when agreeing with the AI (one click)", () => {
    const { onDecide } = setup(supported);
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onDecide).toHaveBeenCalledWith("APPROVE");
  });

  it("asks for a structured reason before approving against the evidence", () => {
    const { onDecide } = setup(contradictory);
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByText("Approve against the AI?")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Approve with reason" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "AI_MISSED_EVIDENCE" } });
    fireEvent.click(submit);
    expect(onDecide).toHaveBeenCalledWith("APPROVE", { code: "AI_MISSED_EVIDENCE", text: "" });
  });

  it("supports keyboard shortcuts A / R / E / N", () => {
    const { onDecide, onSkip } = setup(supported);
    fireEvent.keyDown(window, { key: "a" });
    expect(onDecide).toHaveBeenCalledWith("APPROVE");
    fireEvent.keyDown(window, { key: "e" });
    expect(onDecide).toHaveBeenCalledWith("ESCALATE");
    fireEvent.keyDown(window, { key: "n" });
    expect(onSkip).toHaveBeenCalled();
  });

  it("ignores shortcuts while typing", () => {
    const { onDecide } = setup(supported);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "a" });
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe("WipeCompare", () => {
  it("is a keyboard-operable slider starting at 50%", () => {
    render(<WipeCompare locationId="l" beforeId="b" afterId="a" beforeRef="IMG001" afterRef="IMG002" />);
    const slider = screen.getByRole("slider", { name: /Compare IMG001 \(before\) with IMG002 \(after\)/ });
    expect(slider.getAttribute("aria-valuenow")).toBe("50");
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(slider.getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByAltText("Before: IMG001").getAttribute("src")).toBe("/api/locations/l/images/b/content?variant=full");
  });
});
