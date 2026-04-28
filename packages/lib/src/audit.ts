/**
 * Audit events emitted by the LLM-backed condition evaluator.
 *
 * Audit logging is a healthcare-grade requirement: every LLM-driven
 * routing decision must be replayable post-hoc. The schema is a
 * discriminated union so consumers can pattern-match by `type` and
 * receive correctly-narrowed fields.
 *
 * Events MUST NOT contain PHI. Patient response data (free text, choice
 * values, etc.) is deliberately excluded — only the rule-side metadata
 * (questionId, operator) and model-side metadata (modelVersion,
 * confidence) is recorded.
 */
export type AuditEvent =
  | {
      readonly type: "llm.evaluate.success";
      readonly questionId: string;
      readonly operator: string;
      readonly result: boolean;
      readonly confidence: number;
      readonly modelVersion: string;
      readonly reasoning?: string;
      readonly timestamp: Date;
    }
  | {
      readonly type: "llm.evaluate.fallback.error";
      readonly questionId: string;
      readonly operator: string;
      readonly errorName: string;
      readonly errorMessage: string;
      readonly timestamp: Date;
    }
  | {
      readonly type: "llm.evaluate.fallback.low_confidence";
      readonly questionId: string;
      readonly operator: string;
      readonly confidence: number;
      readonly threshold: number;
      readonly modelVersion: string;
      readonly timestamp: Date;
    }
  | {
      readonly type: "llm.evaluate.fallback.invalid_response";
      readonly questionId: string;
      readonly operator: string;
      readonly reason: string;
      readonly timestamp: Date;
    };

/**
 * Sink for audit events.
 *
 * In production, implementations would write to a durable, append-only
 * store (e.g., a managed write-ahead log, an immutable S3 bucket, or
 * a HIPAA-compliant database table) with proper retention policies.
 *
 * `record` MUST NOT throw. Audit failures are logged separately by the
 * implementation but never block the routing decision — patients should
 * not be denied care because logging is degraded.
 */
export interface IAuditSink {
  record(event: AuditEvent): void;
}

/**
 * Default audit sink that drops events on the floor.
 *
 * Useful as a no-op in tests or when an integrator hasn't wired up a
 * real sink yet. NOT suitable for production — the deployer is expected
 * to provide a real {@link IAuditSink}.
 */
export class NoopAuditSink implements IAuditSink {
  record(_event: AuditEvent): void {
    // intentionally empty
  }
}
