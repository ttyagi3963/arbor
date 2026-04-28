/**
 * Public surface of `@repo/lib`.
 *
 * Consumers should depend only on the symbols re-exported here. Concrete
 * classes (`IntakeEngine`, `DeterministicConditionEvaluator`,
 * `LLMConditionEvaluator`) are deliberately not exposed — instances are
 * obtained through the factory functions in {@link ./container} so
 * implementations can evolve without breaking call sites.
 */

// ── Factories (the composition root) ──────────────────────────────────
export { createEngine, createLLMEngine } from "./container.js";
export type { CreateLLMEngineOptions } from "./container.js";

// ── Engine contracts ─────────────────────────────────────────────────
export type { IConditionEvaluator, IIntakeEngine } from "./interfaces.js";

// ── LLM integration contracts ────────────────────────────────────────
export type { ILLMClient, LLMPrompt, LLMResponse } from "./llm-client.js";
export type { LLMConditionEvaluatorOptions } from "./llm-condition-evaluator.js";

// ── Audit ─────────────────────────────────────────────────────────────
export type { AuditEvent, IAuditSink } from "./audit.js";
export { NoopAuditSink } from "./audit.js";
