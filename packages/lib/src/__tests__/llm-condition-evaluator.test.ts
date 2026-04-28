import { describe, expect, it, vi } from "vitest";
import type { Condition, PatientResponse } from "@repo/contracts";
import type { IConditionEvaluator } from "../interfaces.js";
import type {
  ILLMClient,
  LLMPrompt,
  LLMResponse,
} from "../llm-client.js";
import type { AuditEvent, IAuditSink } from "../audit.js";
import { LLMConditionEvaluator } from "../llm-condition-evaluator.js";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const condition: Condition = {
  questionId: "q_symptoms",
  operator: "includes",
  value: "chest_pain",
};
const history: PatientResponse[] = [];

class FakeClient implements ILLMClient {
  evaluate = vi.fn(
    async (_prompt: LLMPrompt): Promise<LLMResponse> => ({
      result: true,
      confidence: 0.9,
      modelVersion: "fake-model@v1",
      reasoning: "deterministic stub",
    }),
  );
}

class CapturingAuditSink implements IAuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
}

const fallbackTrue: IConditionEvaluator = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async evaluate(): Promise<boolean> {
    return true;
  },
};

const fallbackFalse: IConditionEvaluator = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async evaluate(): Promise<boolean> {
    return false;
  },
};

// ─────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────

describe("LLMConditionEvaluator — construction", () => {
  it("rejects an out-of-range confidence threshold", () => {
    const client = new FakeClient();
    expect(
      () =>
        new LLMConditionEvaluator(client, fallbackTrue, {
          confidenceThreshold: 1.5,
        }),
    ).toThrow(RangeError);

    expect(
      () =>
        new LLMConditionEvaluator(client, fallbackTrue, {
          confidenceThreshold: -0.1,
        }),
    ).toThrow(RangeError);

    expect(
      () =>
        new LLMConditionEvaluator(client, fallbackTrue, {
          confidenceThreshold: Number.NaN,
        }),
    ).toThrow(RangeError);
  });

  it("uses 0.7 as the default confidence threshold", async () => {
    const client = new FakeClient();
    client.evaluate.mockResolvedValueOnce({
      result: true,
      confidence: 0.69, // just below default
      modelVersion: "v1",
    });

    const audit = new CapturingAuditSink();
    const evaluator = new LLMConditionEvaluator(client, fallbackFalse, {
      auditSink: audit,
    });

    const result = await evaluator.evaluate(condition, history);
    expect(result).toBe(false); // fallback fired

    expect(audit.events[0]?.type).toBe("llm.evaluate.fallback.low_confidence");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────

describe("LLMConditionEvaluator — happy path", () => {
  it("returns the model's verdict when confidence meets the threshold", async () => {
    const client = new FakeClient();
    const audit = new CapturingAuditSink();
    const evaluator = new LLMConditionEvaluator(client, fallbackFalse, {
      auditSink: audit,
    });

    const result = await evaluator.evaluate(condition, history);

    expect(result).toBe(true);
    expect(client.evaluate).toHaveBeenCalledWith({ condition, history });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      type: "llm.evaluate.success",
      questionId: "q_symptoms",
      operator: "includes",
      result: true,
      confidence: 0.9,
      modelVersion: "fake-model@v1",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Guardrails — fallback paths
// ─────────────────────────────────────────────────────────────────────

describe("LLMConditionEvaluator — error fallback", () => {
  it("falls back to the deterministic evaluator when the client throws", async () => {
    const client = new FakeClient();
    client.evaluate.mockRejectedValueOnce(new Error("network down"));

    const audit = new CapturingAuditSink();
    const evaluator = new LLMConditionEvaluator(client, fallbackTrue, {
      auditSink: audit,
    });

    const result = await evaluator.evaluate(condition, history);

    expect(result).toBe(true); // fallbackTrue
    expect(audit.events[0]).toMatchObject({
      type: "llm.evaluate.fallback.error",
      questionId: "q_symptoms",
      operator: "includes",
      errorName: "Error",
      errorMessage: "network down",
    });
  });

  it("falls back gracefully when the client throws a non-Error value", async () => {
    const client = new FakeClient();
    client.evaluate.mockRejectedValueOnce("string thrown directly");

    const audit = new CapturingAuditSink();
    const evaluator = new LLMConditionEvaluator(client, fallbackFalse, {
      auditSink: audit,
    });

    const result = await evaluator.evaluate(condition, history);
    expect(result).toBe(false);
    expect(audit.events[0]).toMatchObject({
      type: "llm.evaluate.fallback.error",
      errorName: "UnknownError",
    });
  });
});

describe("LLMConditionEvaluator — low confidence fallback", () => {
  it("falls back when confidence is below the configured threshold", async () => {
    const client = new FakeClient();
    client.evaluate.mockResolvedValueOnce({
      result: true,
      confidence: 0.5,
      modelVersion: "v1",
    });

    const audit = new CapturingAuditSink();
    const evaluator = new LLMConditionEvaluator(client, fallbackFalse, {
      confidenceThreshold: 0.9,
      auditSink: audit,
    });

    const result = await evaluator.evaluate(condition, history);

    expect(result).toBe(false);
    expect(audit.events[0]).toMatchObject({
      type: "llm.evaluate.fallback.low_confidence",
      confidence: 0.5,
      threshold: 0.9,
      modelVersion: "v1",
    });
  });

  it("trusts the model when confidence equals the threshold (>= semantics)", async () => {
    const client = new FakeClient();
    client.evaluate.mockResolvedValueOnce({
      result: true,
      confidence: 0.7,
      modelVersion: "v1",
    });

    const evaluator = new LLMConditionEvaluator(client, fallbackFalse, {
      confidenceThreshold: 0.7,
    });

    const result = await evaluator.evaluate(condition, history);
    expect(result).toBe(true);
  });
});

describe("LLMConditionEvaluator — schema-validation fallback", () => {
  it("falls back when the response is missing modelVersion", async () => {
    const client = new FakeClient();
    client.evaluate.mockResolvedValueOnce({
      result: true,
      confidence: 0.95,
      // modelVersion missing
    } as unknown as LLMResponse);

    const audit = new CapturingAuditSink();
    const evaluator = new LLMConditionEvaluator(client, fallbackFalse, {
      auditSink: audit,
    });

    const result = await evaluator.evaluate(condition, history);
    expect(result).toBe(false);
    expect(audit.events[0]).toMatchObject({
      type: "llm.evaluate.fallback.invalid_response",
    });
  });

  it("falls back when result is not a boolean", async () => {
    const client = new FakeClient();
    client.evaluate.mockResolvedValueOnce({
      result: "yes" as unknown as boolean,
      confidence: 0.95,
      modelVersion: "v1",
    });

    const audit = new CapturingAuditSink();
    const evaluator = new LLMConditionEvaluator(client, fallbackFalse, {
      auditSink: audit,
    });

    const result = await evaluator.evaluate(condition, history);
    expect(result).toBe(false);
    expect(audit.events[0]).toMatchObject({
      type: "llm.evaluate.fallback.invalid_response",
    });
  });

  it("falls back when confidence is out of range", async () => {
    const client = new FakeClient();
    client.evaluate.mockResolvedValueOnce({
      result: true,
      confidence: 1.5,
      modelVersion: "v1",
    });

    const audit = new CapturingAuditSink();
    const evaluator = new LLMConditionEvaluator(client, fallbackFalse, {
      auditSink: audit,
    });

    const result = await evaluator.evaluate(condition, history);
    expect(result).toBe(false);
    expect(audit.events[0]).toMatchObject({
      type: "llm.evaluate.fallback.invalid_response",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Audit reliability
// ─────────────────────────────────────────────────────────────────────

describe("LLMConditionEvaluator — audit reliability", () => {
  it("never propagates audit-sink failures to the caller", async () => {
    const client = new FakeClient();
    const brokenSink: IAuditSink = {
      record: vi.fn(() => {
        throw new Error("disk full");
      }),
    };

    const evaluator = new LLMConditionEvaluator(client, fallbackFalse, {
      auditSink: brokenSink,
    });

    // Should not throw despite the sink throwing.
    const result = await evaluator.evaluate(condition, history);
    expect(result).toBe(true);
    expect(brokenSink.record).toHaveBeenCalled();
  });
});
