import type { Condition, PatientResponse } from "@repo/contracts";

/**
 * Structured payload sent to an LLM-backed condition oracle.
 *
 * Carries the same context the deterministic evaluator would see — the
 * condition under evaluation and the full patient response history.
 *
 * IMPORTANT: This payload may contain PHI (Protected Health Information).
 * Implementations of {@link ILLMClient} MUST ensure:
 *   - transport-level encryption,
 *   - BAA-covered or self-hosted models only,
 *   - PHI redaction in any logs that derive from this prompt.
 */
export type LLMPrompt = {
  readonly condition: Condition;
  readonly history: readonly PatientResponse[];
};

/**
 * Validated, typed response from an LLM-backed condition oracle.
 *
 * Implementations of {@link ILLMClient} MUST return only validated objects
 * matching this shape. Raw model output that fails schema validation MUST
 * NOT cross this boundary — clients are responsible for parsing and
 * rejecting malformed completions before they reach the evaluator.
 */
export type LLMResponse = {
  /** The condition's evaluated boolean truth value. */
  readonly result: boolean;
  /** Model's self-reported confidence in `result`. Range: [0, 1]. */
  readonly confidence: number;
  /**
   * Human-readable reasoning. MUST NOT contain PHI.
   * Surfaced to the audit log for review and post-incident replay.
   */
  readonly reasoning?: string;
  /**
   * Model identifier including version (e.g., `"claude-sonnet-4@2026-04-01"`).
   * Required for reproducibility — sessions pin to a specific model version
   * so the same input always produces the same routing decision.
   */
  readonly modelVersion: string;
};

/**
 * Contract for any LLM-backed condition oracle.
 *
 * Implementations are responsible for:
 *   - network transport (HTTPS, BAA-covered endpoints),
 *   - timeout enforcement,
 *   - retry / backoff policy,
 *   - schema validation of model output,
 *   - PHI handling in transit and in any internal logs.
 *
 * The {@link LLMConditionEvaluator} that depends on this interface assumes
 * the contract is honored — anything else is the implementation's
 * responsibility, not the evaluator's.
 *
 * Errors thrown by `evaluate` SHOULD be of a recognizable type so the
 * evaluator can decide whether to retry, fall back, or surface them.
 * Network timeouts and 5xx responses are expected; the evaluator will
 * fall back to its deterministic counterpart on any thrown error.
 */
export interface ILLMClient {
  evaluate(prompt: LLMPrompt): Promise<LLMResponse>;
}
