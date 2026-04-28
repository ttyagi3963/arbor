# arbor

**A versioned, replayable rule-graph engine for clinical triage. Deterministic by default; LLM augmentation behind a typed seam.**

Production-grade architecture in ~700 lines of TypeScript. The engine traverses a versioned graph of rules to drive branching patient flows. Sessions pin to a specific form version at start, so in-progress intake remains reproducible even when the underlying form is edited mid-flight. Condition evaluation sits behind a typed interface, letting an LLM-backed evaluator drop in alongside the deterministic default (same engine, different brain) with healthcare-grade guardrails (schema validation, confidence threshold, deterministic fallback, audit logging) wired in code, not just described in prose.

The repo is structured as a Turborepo monorepo (`@repo/contracts` for shared types, `@repo/lib` for the engine and evaluators) with full dependency injection, immutable session updates, and 41 passing tests covering the deterministic evaluator, the engine including path replay after answer edits, and every LLM guardrail fallback.



---

## Problem

A patient answers a series of questions before seeing a clinician. Each answer may change the next question or terminate the flow. Requirements grow over time:

- New questions, new branches, new edge cases.
- Some answers (free text, ambiguous responses) can't be evaluated by static rules and need an LLM.
- Forms get edited mid-flight; in-progress sessions must remain reproducible.
- Every routing decision must be auditable. This is healthcare.

The system must stay **flexible** as content changes and **deterministic** for the cases where determinism is non-negotiable.

---

## High-level design

```
                        +------------------------------+
                        |       IIntakeEngine          |   public contract
                        +---------------+--------------+
                                        |  implemented by
                                        v
                        +------------------------------+
                        |       IntakeEngine           |   pure orchestrator
                        |       (immutable, async)     |
                        +---------------+--------------+
                                        |  depends on
                                        v
                        +------------------------------+
                        |    IConditionEvaluator       |   internal seam
                        +---------------+--------------+
                                        |  implemented by
                +-----------------------+-------------------------+
                v                       v                         v
      +------------------+   +------------------------+   +--------------+
      |   Deterministic  |   | LLMConditionEvaluator  |   |   Hybrid     |
      |   (default)      |   | + guardrails           |   |   (custom)   |
      +------------------+   +------------+-----------+   +--------------+
                                          |  depends on
                                          v
                                 +------------------+
                                 |   ILLMClient     |   transport seam
                                 +------------------+
```

Two interfaces. One pure orchestrator. Multiple swappable evaluators. The composition root, `container.ts`, is the only place that calls `new` on anything concrete.

---

## Repository layout

```
arbor/
+-- packages/
|   +-- contracts/          shared types (IntakeForm, Version, Question,
|   |                       TraversalRule, Condition, PatientResponse, ...)
|   +-- lib/                engine, evaluators, container, fixtures, tests
|   +-- eslint-config/      shared lint config
|   \-- typescript-config/  shared tsconfigs
\-- apps/
    +-- web/                placeholder Next.js app (UI not built)
    \-- docs/               placeholder
```

The interesting code lives in `packages/contracts/src/types.ts` and `packages/lib/src/`.

---

## Part 1: Data model

[`packages/contracts/src/types.ts`](packages/contracts/src/types.ts)

The model is built around five ideas. Each is a deliberate choice, not a default.

### 1. Rules-as-data

```ts
type TraversalRule = {
  id: string;
  fromQuestionId: string;
  conditions: Condition[];   // AND-logic
  nextQuestion: Next;        // discriminated union: question | end
  priority: number;
};
```

Branching logic lives in **data**, not in code. Adding a new branch means inserting a row in a table; no engine changes, no deploy. Conditions are atomic boolean tests; rules are bundles of conditions with a destination and a priority.

### 2. Versioning + per-session pinning

```ts
type Version = { ... rules; questions; ... };
type IntakeForm = { activeVersionId: string; ... };
type PatientIntakeSession = { pinnedVersionId: string; ... };
```

A `Version` is an immutable snapshot of the form's questions and rules. The `IntakeForm` points at the currently-active version. Crucially, **a session pins to a specific version at start time**.

Why: forms get edited. If a clinician updates the form while a patient is mid-flow, the patient must keep walking the version they started on. Edits land in a new `Version`; the old session sees the old rules. Reproducibility is preserved without fancy migration logic.

### 3. Status semantics

```ts
type ResponseStatus = "answered" | "skipped" | "declined";
```

Three states, not two. "Skipped" and "declined" are different things in healthcare: one is "I'd rather not say," one is "the system couldn't ask." Both produce `response: null`, but the audit trail keeps them distinct.

The deterministic evaluator treats both as **non-evaluable**: strict mode, condition fails. Better a rule under-fires than fires on missing data.

### 4. `Next` as a discriminated union

```ts
type Next = { type: "question"; questionId: string } | { type: "end" };
```

Not a nullable string. The discriminator forces the consumer to handle both cases at the type level, and leaves room to extend (`{ type: "escalate"; clinicianId: string }`, `{ type: "loop_back"; questionId: string }`) without breaking existing code.

### 5. Constants exported as values

```ts
export const QUESTION_TYPE = ["Multiple_Choice", "Single_Choice", "Text"] as const;
export type QuestionFormat = typeof QUESTION_TYPE[number];
```

Both shapes: the literal string-literal union (for type checks) and the runtime array (for dropdowns, validators, exhaustive iteration). One source of truth.

### What I'd add with more time

- A `Number` / `Scale` format. Currently numeric questions are modeled as `Text`, which works but is loose.
- Per-condition combinator (`AND` | `OR`) instead of always-AND.
- A `model_pinned_at` field on `PatientIntakeSession` for full LLM reproducibility (parallel to `pinnedVersionId`).
- Branded ISO-date strings for the `Date` fields, since they cross JSON boundaries in any real API.

---

## Part 2: Traversal engine

[`packages/lib/src/intake-engine.ts`](packages/lib/src/intake-engine.ts) and [`packages/lib/src/deterministic-condition-evaluator.ts`](packages/lib/src/deterministic-condition-evaluator.ts)

The engine is decomposed into four layers, each with one responsibility. Dependencies flow strictly downward.

### Layer 1: `evaluateCondition`

> "Given one condition and the patient's history, did this single test pass?"

Implemented as `IConditionEvaluator.evaluate`. Atomic boolean test. The only place operators (`equals`, `not_equals`, `includes`, `not_includes`) are interpreted. Adding a new operator is a one-method change.

### Layer 2: `evaluateRule` (private)

> "Did all the conditions on this rule pass? (AND-logic)"

Lives as a `private` method on `IntakeEngine`. Not on any interface: there's only one way to AND a list of booleans, so it doesn't deserve a contract. Calls `this.evaluator.evaluate(...)` for each condition; every condition for a rule is evaluated **in parallel** via `Promise.all`.

### Layer 3: `resolveNext`

> "Given the current question and the patient's history, where does the engine route?"

Filters rules by `fromQuestionId`, evaluates each (in parallel), picks the highest-priority survivor. Throws if no rule matches: a misconfigured form is a loud error, not silent termination.

`resolveNext` deliberately does **not** take a session. It only needs `(fromQuestionId, version, history)`. This makes it pure and **replayable**: the canonical use case is "the patient edited an answer; recompute the downstream path." See [the path-replay tests](packages/lib/src/__tests__/intake-engine.test.ts).

### Layer 4: `step`

> "Given a session and a new answer, produce the next session."

Validates session state, appends the new response to history, asks `resolveNext` where to go, and returns a new session object. Immutable: the input session is never mutated. Returns the new `PatientResponse` and `PatientIntakeSession` so the caller can persist them atomically.

### Why async?

Every layer returns `Promise<...>`. The deterministic evaluator could be synchronous, but the LLM evaluator can't, and the interface has to accommodate both. Native array methods (`every`, `filter`) don't await Promises, so the engine uses the explicit `Promise.all + .every` / `.filter-by-index` pattern. This is documented in the engine source so nobody re-introduces the bug later.

---

## Part 3: LLM integration

[`packages/lib/src/llm-condition-evaluator.ts`](packages/lib/src/llm-condition-evaluator.ts), [`packages/lib/src/llm-client.ts`](packages/lib/src/llm-client.ts), [`packages/lib/src/audit.ts`](packages/lib/src/audit.ts)

### The seam

The engine depends on `IConditionEvaluator`. The default implementation is deterministic. The LLM lives behind the **same interface**: `LLMConditionEvaluator implements IConditionEvaluator`. The engine cannot tell which it has.

Swapping is a single argument:

```ts
import { createEngine, createLLMEngine } from "@repo/lib";

// Deterministic (the safe default)
const engine = createEngine();

// LLM-augmented, with deterministic fallback on every guardrail trip
const llmEngine = createLLMEngine({
  client: myLLMClient,
  confidenceThreshold: 0.7,
  auditSink: myDurableAuditSink,
});
```

### Why this seam, not some other one

Three alternatives I considered and rejected:

1. **Pre-process free text into structured signals before the engine sees it.** Cleaner in some ways, but you have to know in advance which inputs need an LLM. Coupling the LLM to specific question types is rigid.
2. **Have the engine itself know about the LLM and call it for certain operators.** Pollutes the engine. The engine should be deterministic and have a single dependency surface; "what does this condition mean" is a separable concern.
3. **A second interface for "fuzzy" evaluators alongside the deterministic one.** Two interfaces, the engine picks based on operator. Workable but doubles the surface.

The chosen seam is at the `IConditionEvaluator` boundary. One interface, multiple implementations. Engine never changes. The LLM evaluator can also delegate to the deterministic evaluator for operators it doesn't need to handle, giving you a hybrid for free.

### Guardrails (in code, not just in the README)

[`LLMConditionEvaluator`](packages/lib/src/llm-condition-evaluator.ts) wraps every model call in production guardrails. Each is enforced at the type level, the runtime, or both:

| # | Guardrail | Where it lives |
|---|---|---|
| 1 | **Schema validation of model output** | `validateResponse` re-checks shape at evaluator boundary even though the client contract requires it. Defense in depth. |
| 2 | **Confidence threshold + fallback** | `confidenceThreshold` (default 0.7); below this, defer to deterministic. Healthcare-grade conservatism. |
| 3 | **Error fallback** | `try/catch` around the client call; any throw becomes a deterministic decision. The session never blocks on the LLM. |
| 4 | **Audit logging** | Every decision (success and fallback) emits an `AuditEvent` to an injected `IAuditSink`. Replayable post-hoc. |
| 5 | **Audit reliability** | `recordSafe`; sink failures never propagate. Patients are not denied care because logging is degraded. |
| 6 | **Model version pinning** | `modelVersion` is a **required** field on `LLMResponse`. Reproducibility is enforced by the type system. |
| 7 | **PHI separation in audit** | `AuditEvent` deliberately omits `PatientResponse` data: only rule-side metadata (questionId, operator) and model-side metadata (confidence, modelVersion) are recorded. |

### Guardrails the code does not enforce (intentionally)

These are the implementer's responsibility, called out in JSDoc:

- **PHI in transit**: only BAA-covered or self-hosted models. The client's responsibility.
- **Timeout enforcement**: must be inside `ILLMClient.evaluate`. The contract assumes the client is well-behaved.
- **Rate limiting / cost control**: operational concern, not architectural.
- **Prompt injection defense**: patient text must be treated as data, not instructions, by the client implementation.

### What I'd add with more time

- **Shadow mode**. Run the LLM in parallel with the deterministic engine for a release window, log disagreements, never act on the LLM's verdict. Then promote.
- **Per-session caching** of LLM decisions. Same condition + same history yields the same answer. Cuts cost and improves replay determinism.
- **Confidence-aware return type**. `IConditionEvaluator.evaluate(...)` currently returns `Promise<boolean>`. A richer return (`{ result, confidence }`) would let the engine apply policy at routing time, not just inside the LLM evaluator.
- **Human-in-the-loop hooks** for high-stakes paths (chest pain, ideation). Engine surfaces a "halt + escalate" `Next` variant.

---

## How to run

This is an npm-workspaces monorepo using Turborepo.

```bash
# from repo root
npm install

# typecheck everything
npx turbo run check-types

# run the @repo/lib test suite
npm --workspace=@repo/lib test
```

The tests cover:
- All four operators on the deterministic evaluator
- Missing / skipped / declined response semantics
- Engine `step` happy path, urgent-path priority resolution, multi-condition AND, immutability
- Engine `resolveNext` for path replay and misconfigured-form errors
- LLM evaluator: happy path, error fallback, low-confidence fallback, schema-validation fallback, audit-sink-failure isolation
- Custom evaluator injection (the seam)

---

## Trade-offs explicitly named

A few decisions that were calls, not absolutes:

- **Strict-mode evaluation of skipped/declined responses.** Both make every condition referencing them fail, including `not_equals`. This is asymmetric, but in healthcare we'd rather a rule under-fire than fire on absence-as-evidence. Documented in the deterministic evaluator.
- **Throwing on no-rule-matches** instead of returning `null` and treating "no match" as "end." Forces every question to have a default rule. Loud-fail-on-config-error beats silent-end-of-session.
- **Tie-breaking on rule order** when two rules share priority. Deterministic given a stable input order, but order-dependent. A more defensive choice would tie-break on `id`. Not done because the fixture data already orders rules from highest to lowest priority; any future change would need to revisit.
- **Per-call instantiation of the default deterministic evaluator** in `createEngine`. Cheap (the class is stateless), but if profiling ever showed it mattered, switch to a singleton.

---

## What's intentionally absent

This repo is the architecture, not the product. The following are deliberately not built:

- The web UI (`apps/web` is a Next.js placeholder)
- A real LLM client implementation (Anthropic / OpenAI adapters)
- A persistence layer (Drizzle / Prisma / Postgres schema)
- Authentication, authorization, audit storage backend
- A form-authoring UI for clinicians

The seams for all of these exist in the contracts and the package boundaries. The work is to fill them in, not to refactor the architecture.

---

## Known limitations

The architecture is sound, but the implementation has gaps a production deployment would need to close. Naming them explicitly so reviewers don't have to find them.

### 1. Engine isn't bit-exactly reproducible

`step` calls `crypto.randomUUID()` for the response ID and `new Date()` for `answeredAt` directly. Two `step` calls with identical inputs produce different outputs. For audit replay ("given this session and these answers, what *would* the engine have decided?"), the engine should be a pure function of its inputs.

**Fix:** inject an `IClock` and an `IIdGenerator` into the engine constructor with sensible defaults. The current logic stays; the call sites swap to `this.clock.now()` and `this.ids.next()`. Tests already mock the evaluator the same way; mocking the clock is the same shape.

### 2. Per-session model-version pinning isn't enforced

The architecture supports it (every `LLMResponse` carries `modelVersion`), but `PatientIntakeSession` doesn't have a `pinnedModelVersion` field, and the LLM evaluator doesn't reject responses whose model version drifts mid-session. So if the underlying LLM is upgraded while a patient is mid-flow, downstream answers may come from a different model than upstream ones.

**Fix:** add `pinnedModelVersion: string | null` to `PatientIntakeSession`; the LLM evaluator pins on first call and rejects mismatched responses thereafter (or falls back deterministically and audits the drift).

### 3. No runtime kill switch for LLM evaluation

To disable LLM evaluation in an incident, you'd have to redeploy with `createEngine()` instead of `createLLMEngine()`. Production wants a runtime feature flag: turn LLM off for an org, a session type, or globally without a deploy.

**Fix:** add an `enabled` predicate to the LLM evaluator (`(condition, history) => boolean`) that short-circuits to fallback when false. Wire to LaunchDarkly / Unleash / a config service.

### 4. No idempotency on duplicate `step` calls

If a patient retries a request (network blip, double-tap), the engine appends two `PatientResponse` entries with different IDs. The engine doesn't detect or dedupe duplicates.

**Fix:** require an idempotency key on the input; reject (or deduplicate) repeated keys for the same session.

### 5. `LLMResponse.reasoning` could leak PHI through the audit log

The contract says reasoning MUST NOT contain PHI, but we don't validate that. If a model returns `reasoning: "patient said they had chest pain for three days"`, that string lands in the audit log unredacted.

**Fix:** either strip the field at the evaluator boundary, or pass it through an injected redactor. Or document that the contract assertion is the caller's responsibility (currently implicit; should be explicit).

### 6. No structured logger / tracing / metrics

We have audit, but audit is not logging is not metrics. There's no correlation ID flowing through the engine, no OpenTelemetry hooks, no counters for fallback rates or condition-evaluation latency. A production deployment would want all three; the engine should expose hooks rather than the surrounding system shimming them in.

### 7. Error handling is undifferentiated

All client errors fall back identically. A production system would distinguish:

- **Transient (timeout, 5xx, network):** fall back, expected.
- **Configuration (4xx):** don't fall back, fail loud. It's a bug, not a transient issue.
- **Authentication / authorization:** don't fall back, alert. It's a security signal.

Currently treated as "transient, fall back" everywhere. Conservative-correct, but loses signal.

### 8. Strict mode on missing responses is asymmetric

A skipped or declined response makes every condition referencing it fail, including `not_equals`. Documented in the deterministic evaluator. The architectural alternative is a "tri-valued" boolean (`true | false | unknown`) propagated through `evaluateRule` and `resolveNext`. Worth doing if the policy ever needs to distinguish "answered no" from "didn't answer."

---

## Closing note

The point of the architecture is not the elegance, it's the **reversibility**. Every choice that could plausibly need to change later (the static evaluator, the LLM behind it, the audit sink, the form versions) sits behind a typed interface. Nothing in the engine is married to anything else.

If something here saves a half-hour of design debate, that's the goal.
