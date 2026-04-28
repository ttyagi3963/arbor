import type { Condition, PatientResponse } from "@repo/contracts";
import type { IConditionEvaluator } from "./interfaces.js";

export class DeterministicConditionEvaluator implements IConditionEvaluator {
  async evaluate(
    condition: Condition,
    history: PatientResponse[],
  ): Promise<boolean> {
    const response = history.find((h) => h.questionId === condition.questionId);
    if (
      !response ||
      response.status !== "answered" ||
      response.response === null
    ) {
      return false;
    }

    const answer = response.response;

    switch (condition.operator) {
      case "equals":
        return answer === condition.value;

      case "not_equals":
        return answer !== condition.value;

      case "includes":
        return Array.isArray(answer) && answer.includes(condition.value);

      case "not_includes":
        return Array.isArray(answer) && !answer.includes(condition.value);

      // Future "fuzzy" operators (e.g. semantic_match, implies, mentions)
      // would not live here — they belong on an LLM-backed evaluator
      // implementing the same IConditionEvaluator contract. The deterministic
      // evaluator deliberately handles only operators with a closed-form,
      // value-comparison semantics.

      default: {
        const _exhaustive: never = condition.operator;
        return false;
      }
    }
  }
}
