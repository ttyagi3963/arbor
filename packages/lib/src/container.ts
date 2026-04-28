import type { IConditionEvaluator, IIntakeEngine } from "./interfaces.js";
import type { ILLMClient } from "./llm-client.js";
import type { IAuditSink } from "./audit.js";
import { DeterministicConditionEvaluator } from "./deterministic-condition-evaluator.js";
import { IntakeEngine } from "./intake-engine.js";
import { LLMConditionEvaluator } from "./llm-condition-evaluator.js";

/**
 * Composition root for the intake engine.
 *
 * This file is the *only* place in the codebase that calls `new` on
 * concrete implementations. Everywhere else — apps, services, tests —
 * depends on the interfaces (`IIntakeEngine`, `IConditionEvaluator`)
 * and receives instances through these factories.
 *
 * Two factories are exposed:
 *   - {@link createEngine}: deterministic-only engine (the default).
 *   - {@link createLLMEngine}: LLM-augmented engine with deterministic
 *     fallback. Suitable for staged rollout (start with shadow mode,
 *     then promote).
 */

/**
 * Creates an engine that uses purely deterministic condition evaluation.
 *
 * This is the safest default — every routing decision is reproducible,
 * fully testable offline, and free of model dependencies. Use this for
 * the baseline product, regulated environments without LLM approval, or
 * any path where determinism is required.
 *
 * @param evaluator Optional override for the condition evaluator.
 *                  Defaults to a fresh {@link DeterministicConditionEvaluator}.
 *                  Tests typically inject a mock implementation here.
 */
export function createEngine(
  evaluator: IConditionEvaluator = new DeterministicConditionEvaluator(),
): IIntakeEngine {
  return new IntakeEngine(evaluator);
}

/**
 * Options for {@link createLLMEngine}.
 */
export interface CreateLLMEngineOptions {
  /** The LLM client used by the LLM-backed evaluator. */
  readonly client: ILLMClient;
  /**
   * Confidence floor for trusting LLM verdicts. Below this, the engine
   * falls back to the deterministic evaluator. Defaults to 0.7.
   */
  readonly confidenceThreshold?: number;
  /**
   * Audit sink for LLM decisions. Defaults to a no-op sink, but production
   * deployments MUST inject a durable sink for replayability.
   */
  readonly auditSink?: IAuditSink;
  /**
   * Override for the deterministic fallback evaluator. Defaults to a
   * fresh {@link DeterministicConditionEvaluator}.
   */
  readonly fallback?: IConditionEvaluator;
}

/**
 * Creates an engine that uses an LLM for condition evaluation, with
 * deterministic fallback on low confidence, schema failure, or error.
 *
 * The engine never bypasses the deterministic path — the LLM only
 * augments it. If anything goes wrong upstream of the engine, routing
 * still works using the rule-based evaluator.
 */
export function createLLMEngine(options: CreateLLMEngineOptions): IIntakeEngine {
  const fallback = options.fallback ?? new DeterministicConditionEvaluator();

  const evaluator = new LLMConditionEvaluator(options.client, fallback, {
    confidenceThreshold: options.confidenceThreshold,
    auditSink: options.auditSink,
  });

  return new IntakeEngine(evaluator);
}
