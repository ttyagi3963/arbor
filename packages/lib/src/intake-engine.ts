import type {
  Next,
  PatientIntakeSession,
  PatientResponse,
  ResponseStatus,
  ResponseValue,
  TraversalRule,
  Version,
} from "@repo/contracts";
import type { IConditionEvaluator, IIntakeEngine } from "./interfaces.js";

/**
 * Pure, immutable intake engine.
 *
 * The engine owns three responsibilities and nothing else:
 *   1. Validating that a session is in a state where it can advance.
 *   2. Appending a new {@link PatientResponse} to history.
 *   3. Resolving the next destination given the (now-updated) history.
 *
 * It delegates all condition truth-checking to an injected
 * {@link IConditionEvaluator}. This is the seam that lets the same
 * engine power a fully-deterministic deployment, an LLM-augmented
 * deployment, or a hybrid — by swapping the evaluator alone.
 *
 * `step` is the only stateful-feeling method: it produces a new session
 * object derived from the inputs. The class itself holds no per-call
 * state and is safe to share across concurrent requests.
 */
export class IntakeEngine implements IIntakeEngine {
  constructor(private readonly evaluator: IConditionEvaluator) {}

  private async evaluateRule(
    rule: TraversalRule,
    history: PatientResponse[],
  ): Promise<boolean> {
    if (rule.conditions.length === 0) return true;
    const results = await Promise.all(
      rule.conditions.map((c) => this.evaluator.evaluate(c, history)),
    );
    return results.every((r) => r === true);
  }

  async resolveNext(
    version: Version,
    fromQuestionId: string,
    history: PatientResponse[],
  ): Promise<Next> {
    // Narrow to rules that originate at the current question.
    const applicableRules = version.rules.filter(
      (rule) => rule.fromQuestionId === fromQuestionId,
    );

    const matchResults = await Promise.all(
      applicableRules.map((ar) => this.evaluateRule(ar, history)),
    );

    const matchingRules = applicableRules.filter((_, i) => matchResults[i]);

    if (matchingRules.length === 0) {
      throw new Error(
        `No matching rule found for question ${fromQuestionId}. ` +
          `Every question must have at least a default rule.`,
      );
    }

    const winner = matchingRules.reduce((best, rule) =>
      rule.priority > best.priority ? rule : best,
    );

    return winner.nextQuestion;
  }

  async step(
    session: PatientIntakeSession,
    version: Version,
    history: PatientResponse[],
    input: {
      response: ResponseValue | null;
      status: ResponseStatus;
    },
  ): Promise<{
    newResponse: PatientResponse;
    updatedSession: PatientIntakeSession;
  }> {
    // 1. Guard: the session must be in progress
    if (session.status !== "in_progress") {
      throw new Error(
        `Cannot step session "${session.id}" with status "${session.status}". Expected "in_progress".`,
      );
    }

    // 2. Guard: the session must be pointed at an open question.
    if (session.currentQuestionId === null) {
      throw new Error(
        `Cannot advance session "${session.id}": no currentQuestionId set. ` +
          `A completed or freshly-initialised session must be reopened explicitly.`,
      );
    }

    // 3. Build the new response from the input
    const newResponse: PatientResponse = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      questionId: session.currentQuestionId,
      response: input.response,
      status: input.status,
      answeredAt: new Date(),
    };

    // 4. Decide where to go next, evaluating against the updated history

    const updatedHistory = [...history, newResponse];
    const next = await this.resolveNext(
      version,
      session.currentQuestionId,
      updatedHistory,
    );

    // 5. Compute the updated session from the next decision

    const updatedSession: PatientIntakeSession =
      next.type === "end"
        ? {
            ...session,
            currentQuestionId: null,
            status: "completed",
            completedAt: new Date(),
          }
        : {
            ...session,
            currentQuestionId: next.questionId,
          };

    return { newResponse, updatedSession };
  }
}
