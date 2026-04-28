import type {
  Condition,
  Next,
  PatientIntakeSession,
  PatientResponse,
  ResponseStatus,
  ResponseValue,
  Version,
} from "@repo/contracts";

export interface IConditionEvaluator {
  evaluate(condition: Condition, history: PatientResponse[]): Promise<boolean>;
}

export interface IIntakeEngine {
  resolveNext(
    version: Version,
    fromQuestionId: string,
    history: PatientResponse[],
  ): Promise<Next>;

  step(
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
  }>;
}
