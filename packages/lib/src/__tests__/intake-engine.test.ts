import { describe, expect, it } from "vitest";
import type {
  Condition,
  PatientIntakeSession,
  PatientResponse,
  TraversalRule,
  Version,
} from "@repo/contracts";
import { createEngine } from "../container.js";
import {
  intakeForm,
  questions,
  rules,
  version as sampleVersion,
} from "../sample-form.js";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

function makeSession(currentQuestionId: string | null): PatientIntakeSession {
  return {
    id: "sess_test",
    patientId: "pat_test",
    intakeFormId: intakeForm.id,
    pinnedVersionId: sampleVersion.id,
    status: "in_progress",
    startedAt: new Date("2026-04-25T10:00:00Z"),
    completedAt: null,
    currentQuestionId,
  };
}

function answered(
  questionId: string,
  response: PatientResponse["response"],
): PatientResponse {
  return {
    id: `r_${questionId}`,
    sessionId: "sess_test",
    questionId,
    response,
    status: "answered",
    answeredAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// step()
// ─────────────────────────────────────────────────────────────────────

describe("IntakeEngine.step", () => {
  it("advances to the next question on a default rule", async () => {
    const engine = createEngine();
    const session = makeSession("q_pregnancy");

    const { newResponse, updatedSession } = await engine.step(
      session,
      sampleVersion,
      [],
      { response: "no", status: "answered" },
    );

    expect(updatedSession.currentQuestionId).toBe("q_symptoms");
    expect(updatedSession.status).toBe("in_progress");
    expect(newResponse.questionId).toBe("q_pregnancy");
    expect(newResponse.response).toBe("no");
    expect(newResponse.status).toBe("answered");
  });

  it("routes urgently when chest pain is selected (priority 10 > default 0)", async () => {
    const engine = createEngine();
    const session = makeSession("q_symptoms");

    const { updatedSession } = await engine.step(session, sampleVersion, [], {
      response: ["headache", "chest_pain"],
      status: "answered",
    });

    expect(updatedSession.currentQuestionId).toBe("q_chest_pain_severity");
  });

  it("routes elderly + non-mild chest pain to end (multi-condition AND, priority 20)", async () => {
    const engine = createEngine();
    const session = makeSession("q_chest_pain_severity");
    const history = [
      answered("q_age", "over_65"),
      answered("q_symptoms", ["chest_pain"]),
    ];

    const { updatedSession } = await engine.step(
      session,
      sampleVersion,
      history,
      { response: "moderate", status: "answered" },
    );

    expect(updatedSession.currentQuestionId).toBeNull();
    expect(updatedSession.status).toBe("completed");
    expect(updatedSession.completedAt).toBeInstanceOf(Date);
  });

  it("returns deterministic IDs and timestamps that are populated", async () => {
    const engine = createEngine();
    const session = makeSession("q_pregnancy");
    const { newResponse } = await engine.step(session, sampleVersion, [], {
      response: "no",
      status: "answered",
    });

    expect(newResponse.id).toMatch(/^[0-9a-f-]{36}$/i); // uuid
    expect(newResponse.answeredAt).toBeInstanceOf(Date);
  });

  it("does not mutate the input session", async () => {
    const engine = createEngine();
    const session = makeSession("q_pregnancy");
    const before = { ...session };

    await engine.step(session, sampleVersion, [], {
      response: "no",
      status: "answered",
    });

    expect(session).toEqual(before);
  });

  it("throws when the session is not in_progress", async () => {
    const engine = createEngine();
    const session: PatientIntakeSession = {
      ...makeSession("q_pregnancy"),
      status: "completed",
    };

    await expect(
      engine.step(session, sampleVersion, [], {
        response: "no",
        status: "answered",
      }),
    ).rejects.toThrow(/cannot step session/i);
  });

  it("throws when the session has no currentQuestionId", async () => {
    const engine = createEngine();
    const session = makeSession(null);

    await expect(
      engine.step(session, sampleVersion, [], {
        response: "no",
        status: "answered",
      }),
    ).rejects.toThrow(/cannot advance/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// resolveNext() — exercised directly for path replay scenarios
// ─────────────────────────────────────────────────────────────────────

describe("IntakeEngine.resolveNext", () => {
  it("picks the higher-priority rule when multiple match", async () => {
    const engine = createEngine();
    const next = await engine.resolveNext(sampleVersion, "q_symptoms", [
      answered("q_symptoms", ["chest_pain"]),
    ]);

    expect(next).toEqual({
      type: "question",
      questionId: "q_chest_pain_severity",
    });
  });

  it("falls back to the empty-conditions default when no high-priority rule matches", async () => {
    const engine = createEngine();
    const next = await engine.resolveNext(sampleVersion, "q_symptoms", [
      answered("q_symptoms", ["headache"]),
    ]);

    expect(next).toEqual({
      type: "question",
      questionId: "q_other_symptoms",
    });
  });

  it("returns end on a terminal rule", async () => {
    const engine = createEngine();
    const next = await engine.resolveNext(sampleVersion, "q_consent", [
      answered("q_consent", false),
    ]);

    expect(next).toEqual({ type: "end" });
  });

  it("throws when no rule matches (misconfigured form)", async () => {
    const engine = createEngine();
    const minimalVersion: Version = {
      ...sampleVersion,
      questions: [questions[0]!],
      rules: [], // no rules at all → unreachable from any question
    };

    await expect(
      engine.resolveNext(minimalVersion, "q_age", []),
    ).rejects.toThrow(/no matching rule found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Path replay — the headline payoff of having a pure resolveNext
// ─────────────────────────────────────────────────────────────────────

describe("IntakeEngine — path replay", () => {
  it("can recompute a downstream path when an earlier answer changes", async () => {
    const engine = createEngine();

    // Original history routes through q_symptoms (default → q_other_symptoms)
    const originalHistory = [answered("q_symptoms", ["headache"])];
    const original = await engine.resolveNext(
      sampleVersion,
      "q_symptoms",
      originalHistory,
    );
    expect(original).toEqual({
      type: "question",
      questionId: "q_other_symptoms",
    });

    // Patient edits the same answer to add chest_pain → urgent path fires.
    const editedHistory = [answered("q_symptoms", ["chest_pain"])];
    const replayed = await engine.resolveNext(
      sampleVersion,
      "q_symptoms",
      editedHistory,
    );
    expect(replayed).toEqual({
      type: "question",
      questionId: "q_chest_pain_severity",
    });
  });

  it("rules with empty conditions are 'vacuously true' and act as defaults", async () => {
    const engine = createEngine();
    const onlyDefault: TraversalRule[] = [
      {
        id: "r_default",
        fromQuestionId: "qx",
        conditions: [], // empty → fires unconditionally
        nextQuestion: { type: "end" },
        priority: 0,
      },
    ];
    const next = await engine.resolveNext(
      { ...sampleVersion, rules: onlyDefault },
      "qx",
      [],
    );
    expect(next).toEqual({ type: "end" });
  });

  it("evaluates multi-condition AND-rules against the full response history", async () => {
    const engine = createEngine();
    const history = [
      answered("q_age", "over_65"),
      answered("q_symptoms", ["chest_pain"]),
      answered("q_chest_pain_severity", "moderate"),
    ];

    // The high-risk-combo rule is priority 20 and fires when:
    //   q_age == "over_65" AND q_chest_pain_severity != "mild"
    const next = await engine.resolveNext(
      sampleVersion,
      "q_chest_pain_severity",
      history,
    );

    expect(next).toEqual({ type: "end" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Custom evaluator injection — the seam the LLM evaluator uses
// ─────────────────────────────────────────────────────────────────────

describe("IntakeEngine — custom evaluator injection", () => {
  it("uses the injected evaluator instead of the deterministic one", async () => {
    // An evaluator that always says "false". With it, every condition
    // fails, so only rules with empty conditions can fire.
    const engine = createEngine({
      // eslint-disable-next-line @typescript-eslint/require-await
      async evaluate(_c: Condition, _h: PatientResponse[]): Promise<boolean> {
        return false;
      },
    });

    // From q_symptoms there's a "chest_pain" rule (priority 10) and a
    // default rule (priority 0). With our always-false evaluator the
    // chest_pain rule never fires, so we land on the default.
    const next = await engine.resolveNext(sampleVersion, "q_symptoms", [
      answered("q_symptoms", ["chest_pain"]),
    ]);

    expect(next).toEqual({
      type: "question",
      questionId: "q_other_symptoms",
    });
  });
});
