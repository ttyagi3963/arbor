export const QUESTION_TYPE = [
  "Multiple_Choice",
  "Single_Choice",
  "Text",
] as const;
export type QuestionFormat = (typeof QUESTION_TYPE)[number];

export type AnswerValue = string | number | boolean;
export type ResponseValue = AnswerValue | AnswerValue[];
export const RESPONSE_STATUS = ["answered", "skipped", "declined"] as const;
export type ResponseStatus = (typeof RESPONSE_STATUS)[number];

export const SESSION_STATUS = [
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type SessionStatus = (typeof SESSION_STATUS)[number];

export type QuestionChoice = {
  id: string;
  label: string;
};
export type Question = {
  id: string;
  questionText: string;
  format: QuestionFormat;
  choices?: QuestionChoice[];
};

export type Version = {
  id: string;
  intakeFormId: string;
  changeLog: string;
  startQuestionId: string;
  questions: Question[];
  author: string;
  createdAt: Date;
  updatedAt: Date;
  rules: TraversalRule[];
};

export type IntakeForm = {
  id: string;
  name: string;
  activeVersionId: string;
  author: string;
  createdAt: Date;
};

export type Next = { type: "question"; questionId: string } | { type: "end" };

const OPERATOR = [
  "equals",
  "not_equals",
  "includes",
  "not_includes",
  // "implies",
  // "mentions",
  // "matches_context",
] as const;

export type Operator = (typeof OPERATOR)[number];

export type Condition = {
  questionId: string;
  operator: Operator;
  value: AnswerValue;
};

export type TraversalRule = {
  id: string;
  fromQuestionId: string;
  conditions: Condition[];
  nextQuestion: Next;
  priority: number;
};

export type Patient = {
  id: string;
};

export type PatientIntakeSession = {
  id: string;
  patientId: string;
  intakeFormId: string;
  pinnedVersionId: string;
  status: SessionStatus;
  startedAt: Date;
  completedAt: Date | null;
  currentQuestionId: string | null;
};

export type PatientResponse = {
  id: string;
  sessionId: string;
  questionId: string;
  response: ResponseValue | null;
  status: ResponseStatus;
  answeredAt: Date;
};
