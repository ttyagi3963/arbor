import { describe, expect, it } from "vitest";
import type { Condition, PatientResponse } from "@repo/contracts";
import { DeterministicConditionEvaluator } from "../deterministic-condition-evaluator.js";

const evaluator = new DeterministicConditionEvaluator();

const baseResponse = {
  id: "r1",
  sessionId: "s1",
  answeredAt: new Date("2026-04-25T10:00:00Z"),
} as const;

function answered(
  questionId: string,
  response: PatientResponse["response"],
): PatientResponse {
  return {
    ...baseResponse,
    questionId,
    response,
    status: "answered",
  };
}

describe("DeterministicConditionEvaluator", () => {
  describe("equals", () => {
    it("returns true when string answer matches", async () => {
      const condition: Condition = {
        questionId: "q1",
        operator: "equals",
        value: "yes",
      };
      const result = await evaluator.evaluate(condition, [answered("q1", "yes")]);
      expect(result).toBe(true);
    });

    it("returns false when string answer differs", async () => {
      const condition: Condition = {
        questionId: "q1",
        operator: "equals",
        value: "yes",
      };
      const result = await evaluator.evaluate(condition, [answered("q1", "no")]);
      expect(result).toBe(false);
    });

    it("returns true for exact boolean match", async () => {
      const condition: Condition = {
        questionId: "q_consent",
        operator: "equals",
        value: true,
      };
      const result = await evaluator.evaluate(condition, [
        answered("q_consent", true),
      ]);
      expect(result).toBe(true);
    });

    it("returns true for exact number match", async () => {
      const condition: Condition = {
        questionId: "q_pain",
        operator: "equals",
        value: 7,
      };
      const result = await evaluator.evaluate(condition, [answered("q_pain", 7)]);
      expect(result).toBe(true);
    });

    it("returns false when comparing array to scalar (use `includes` instead)", async () => {
      const condition: Condition = {
        questionId: "q_symptoms",
        operator: "equals",
        value: "headache",
      };
      const result = await evaluator.evaluate(condition, [
        answered("q_symptoms", ["headache", "fever"]),
      ]);
      expect(result).toBe(false);
    });
  });

  describe("not_equals", () => {
    it("returns true when answer differs from value", async () => {
      const condition: Condition = {
        questionId: "q1",
        operator: "not_equals",
        value: "yes",
      };
      const result = await evaluator.evaluate(condition, [answered("q1", "no")]);
      expect(result).toBe(true);
    });

    it("returns false when answer matches value", async () => {
      const condition: Condition = {
        questionId: "q1",
        operator: "not_equals",
        value: "yes",
      };
      const result = await evaluator.evaluate(condition, [answered("q1", "yes")]);
      expect(result).toBe(false);
    });
  });

  describe("includes", () => {
    it("returns true when array contains the value", async () => {
      const condition: Condition = {
        questionId: "q_symptoms",
        operator: "includes",
        value: "chest_pain",
      };
      const result = await evaluator.evaluate(condition, [
        answered("q_symptoms", ["headache", "chest_pain", "fever"]),
      ]);
      expect(result).toBe(true);
    });

    it("returns false when array does not contain the value", async () => {
      const condition: Condition = {
        questionId: "q_symptoms",
        operator: "includes",
        value: "nausea",
      };
      const result = await evaluator.evaluate(condition, [
        answered("q_symptoms", ["headache", "fever"]),
      ]);
      expect(result).toBe(false);
    });

    it("returns false when answer is a scalar (degenerate input)", async () => {
      const condition: Condition = {
        questionId: "q1",
        operator: "includes",
        value: "yes",
      };
      const result = await evaluator.evaluate(condition, [answered("q1", "yes")]);
      expect(result).toBe(false);
    });
  });

  describe("not_includes", () => {
    it("returns true when array does not contain the value", async () => {
      const condition: Condition = {
        questionId: "q_symptoms",
        operator: "not_includes",
        value: "chest_pain",
      };
      const result = await evaluator.evaluate(condition, [
        answered("q_symptoms", ["headache", "fever"]),
      ]);
      expect(result).toBe(true);
    });

    it("returns false when array contains the value", async () => {
      const condition: Condition = {
        questionId: "q_symptoms",
        operator: "not_includes",
        value: "chest_pain",
      };
      const result = await evaluator.evaluate(condition, [
        answered("q_symptoms", ["chest_pain"]),
      ]);
      expect(result).toBe(false);
    });
  });

  describe("missing or non-answered responses", () => {
    it("returns false when the referenced question has no response", async () => {
      const condition: Condition = {
        questionId: "q_missing",
        operator: "equals",
        value: "yes",
      };
      const result = await evaluator.evaluate(condition, [answered("q1", "yes")]);
      expect(result).toBe(false);
    });

    it("returns false when the response was skipped", async () => {
      const condition: Condition = {
        questionId: "q1",
        operator: "equals",
        value: "yes",
      };
      const skipped: PatientResponse = {
        ...baseResponse,
        questionId: "q1",
        response: null,
        status: "skipped",
      };
      const result = await evaluator.evaluate(condition, [skipped]);
      expect(result).toBe(false);
    });

    it("returns false when the response was declined", async () => {
      const condition: Condition = {
        questionId: "q1",
        operator: "not_equals",
        value: "yes",
      };
      const declined: PatientResponse = {
        ...baseResponse,
        questionId: "q1",
        response: null,
        status: "declined",
      };
      // Even though the response is not "yes", strict-mode treats absence
      // as non-evaluable — better a rule under-fires than fires on missing data.
      const result = await evaluator.evaluate(condition, [declined]);
      expect(result).toBe(false);
    });
  });
});
