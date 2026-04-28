import type { Condition, PatientResponse } from "@repo/contracts";
import type { IConditionEvaluator } from "./interfaces.js";
import type { ILLMClient, LLMResponse } from "./llm-client.js";
import type { AuditEvent, IAuditSink } from "./audit.js";
import { NoopAuditSink } from "./audit.js";

/**
 * Configuration options for {@link LLMConditionEvaluator}.
 */
export interface LLMConditionEvaluatorOptions {
  /**
   * Confidence floor below which the evaluator falls back to its
   * deterministic counterpart instead of trusting the LLM. Range: [0, 1].
   *
   * Defaults to 0.7. This threshold is deliberately conservative for
   * a healthcare context — silent auto-routing on low-confidence model
   * output is exactly the failure mode we want to prevent.
   */
  readonly confidenceThreshold?: number;

  /**
   * Sink for audit events. Defaults to a no-op sink.
   *
   * Production deployments MUST provide a durable sink — every LLM
   * decision must be replayable for post-incident review.
   */
  readonly auditSink?: IAuditSink;
}

/**
 * LLM-backed implementation of {@link IConditionEvaluator}.
 *
 * Uses a model to evaluate conditions that the deterministic evaluator
 * cannot handle (e.g., free-text symptoms, ambiguous answers). Wraps the
 * model call in production guardrails:
 *
 *   1. Schema validation of the model response (any malformed payload
 *      triggers fallback).
 *   2. Confidence threshold (low-confidence verdicts trigger fallback).
 *   3. Error fallback (network errors, timeouts, throws).
 *   4. Audit logging of every decision (success and fallback paths).
 *
 * The fallback evaluator is injected so the same class works in any
 * deployment posture — production might fall back to deterministic,
 * a shadow-mode deployment might fall back to "always false."
 */
export class LLMConditionEvaluator implements IConditionEvaluator {
  private static readonly DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

  private readonly confidenceThreshold: number;
  private readonly auditSink: IAuditSink;

  constructor(
    private readonly client: ILLMClient,
    private readonly fallback: IConditionEvaluator,
    options: LLMConditionEvaluatorOptions = {},
  ) {
    const threshold =
      options.confidenceThreshold ??
      LLMConditionEvaluator.DEFAULT_CONFIDENCE_THRESHOLD;

    if (threshold < 0 || threshold > 1 || Number.isNaN(threshold)) {
      throw new RangeError(
        `confidenceThreshold must be in [0, 1], received ${threshold}`,
      );
    }

    this.confidenceThreshold = threshold;
    this.auditSink = options.auditSink ?? new NoopAuditSink();
  }

  async evaluate(
    condition: Condition,
    history: PatientResponse[],
  ): Promise<boolean> {
    let response: LLMResponse;

    // 1. Network / timeout / unexpected error → fall back deterministically.
    try {
      response = await this.client.evaluate({ condition, history });
    } catch (error) {
      this.recordSafe({
        type: "llm.evaluate.fallback.error",
        questionId: condition.questionId,
        operator: condition.operator,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage:
          error instanceof Error ? error.message : "Unknown error from client",
        timestamp: new Date(),
      });
      return this.fallback.evaluate(condition, history);
    }

    // 2. Schema validation. We do not trust the client wholesale — even
    //    though the contract requires validated output, defense-in-depth
    //    means we re-check at this boundary.
    const validation = this.validateResponse(response);
    if (!validation.ok) {
      this.recordSafe({
        type: "llm.evaluate.fallback.invalid_response",
        questionId: condition.questionId,
        operator: condition.operator,
        reason: validation.reason,
        timestamp: new Date(),
      });
      return this.fallback.evaluate(condition, history);
    }

    // 3. Confidence threshold. Low confidence → fall back, do not silently
    //    auto-route. In a healthcare context this guardrail is non-optional.
    if (response.confidence < this.confidenceThreshold) {
      this.recordSafe({
        type: "llm.evaluate.fallback.low_confidence",
        questionId: condition.questionId,
        operator: condition.operator,
        confidence: response.confidence,
        threshold: this.confidenceThreshold,
        modelVersion: response.modelVersion,
        timestamp: new Date(),
      });
      return this.fallback.evaluate(condition, history);
    }

    // 4. Happy path. Audit the decision before returning so any
    //    post-hoc replay sees the full provenance.
    this.recordSafe({
      type: "llm.evaluate.success",
      questionId: condition.questionId,
      operator: condition.operator,
      result: response.result,
      confidence: response.confidence,
      modelVersion: response.modelVersion,
      reasoning: response.reasoning,
      timestamp: new Date(),
    });

    return response.result;
  }

  /**
   * Re-validates the LLM response shape at the evaluator boundary.
   *
   * The {@link ILLMClient} contract already requires validated output, but
   * we revalidate here to defend against drift, bugs in client
   * implementations, and schema regressions over time.
   *
   * In production this would typically be a Zod schema parse. Hand-rolled
   * here to keep the package dependency-free.
   */
  private validateResponse(
    response: LLMResponse,
  ): { ok: true } | { ok: false; reason: string } {
    if (response === null || typeof response !== "object") {
      return { ok: false, reason: "response is not an object" };
    }
    if (typeof response.result !== "boolean") {
      return { ok: false, reason: "result must be a boolean" };
    }
    if (
      typeof response.confidence !== "number" ||
      Number.isNaN(response.confidence) ||
      response.confidence < 0 ||
      response.confidence > 1
    ) {
      return { ok: false, reason: "confidence must be a number in [0, 1]" };
    }
    if (
      typeof response.modelVersion !== "string" ||
      response.modelVersion.length === 0
    ) {
      return { ok: false, reason: "modelVersion must be a non-empty string" };
    }
    if (
      response.reasoning !== undefined &&
      typeof response.reasoning !== "string"
    ) {
      return { ok: false, reason: "reasoning, if present, must be a string" };
    }
    return { ok: true };
  }

  /**
   * Records an audit event without ever propagating sink failures.
   *
   * Audit must never block a routing decision. If the sink throws, we
   * swallow the error — production code would emit a metric here so the
   * outage is visible to operators without affecting the patient flow.
   */
  private recordSafe(event: AuditEvent): void {
    try {
      this.auditSink.record(event);
    } catch {
      // Intentionally swallowed. See JSDoc.
    }
  }
}
