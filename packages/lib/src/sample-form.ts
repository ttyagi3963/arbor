/**
 * Sample intake form fixture.
 *
 * Covers every question format and response value type in the contracts:
 *   - Single_Choice  → string responses
 *   - Multiple_Choice → string[] responses
 *   - Text           → long string OR number responses (see note below)
 *   - boolean response (consent flag)
 *   - null response with status "skipped" / "declined"
 *
 * Also exercises every rule pattern the engine must handle:
 *   - default rule (empty conditions, fires unconditionally)
 *   - priority resolution (two rules from the same question, higher wins)
 *   - multi-condition AND-rule (cross-question — depends on answers given earlier)
 *   - operators: equals, not_equals, includes, not_includes
 *   - terminal rule (nextQuestion: { type: "end" })
 *
 * Domain: a basic medical intake. Patient → age → maybe pregnancy →
 * symptoms → maybe urgent triage → free-text → duration → maybe smoking →
 * consent → end.
 */

import type {
  IntakeForm,
  PatientIntakeSession,
  PatientResponse,
  Question,
  TraversalRule,
  Version,
} from "@repo/contracts";

// ---------------------------------------------------------------------------
// Questions — covers every QuestionFormat in the model
// ---------------------------------------------------------------------------

export const questions: Question[] = [
  // Single_Choice (string response)
  {
    id: "q_age",
    questionText: "What is your age range?",
    format: "Single_Choice",
    choices: [
      { id: "under_18", label: "Under 18" },
      { id: "18_to_45", label: "18–45" },
      { id: "45_to_65", label: "45–65" },
      { id: "over_65", label: "Over 65" },
    ],
  },

  // Single_Choice (yes/no semantics — still a string response)
  {
    id: "q_pregnancy",
    questionText: "Are you currently pregnant?",
    format: "Single_Choice",
    choices: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
      { id: "prefer_not_to_say", label: "Prefer not to say" },
    ],
  },

  // Multiple_Choice (string[] response)
  {
    id: "q_symptoms",
    questionText:
      "Which symptoms are you experiencing? (Select all that apply)",
    format: "Multiple_Choice",
    choices: [
      { id: "headache", label: "Headache" },
      { id: "fever", label: "Fever" },
      { id: "cough", label: "Cough" },
      { id: "chest_pain", label: "Chest pain" },
      { id: "shortness_of_breath", label: "Shortness of breath" },
      { id: "nausea", label: "Nausea" },
    ],
  },

  // Single_Choice — only reachable via the urgent path (chest pain present)
  {
    id: "q_chest_pain_severity",
    questionText: "How severe is the chest pain?",
    format: "Single_Choice",
    choices: [
      { id: "mild", label: "Mild" },
      { id: "moderate", label: "Moderate" },
      { id: "severe", label: "Severe" },
    ],
  },

  // Text — free-text answer (this is the Part 3 / LLM-extractor seam)
  {
    id: "q_other_symptoms",
    questionText: "Please describe any other symptoms in detail.",
    format: "Text",
  },

  // Text used for a numeric answer.
  // NOTE: model gap — there is no "Number" or "Scale" format in QuestionFormat.
  // A future extension would add it; for now numeric inputs are typed as text.
  {
    id: "q_pain_level",
    questionText: "On a scale of 1–10, rate your overall pain level.",
    format: "Text",
  },

  // Single_Choice (string response)
  {
    id: "q_duration",
    questionText: "How long have you been experiencing these symptoms?",
    format: "Single_Choice",
    choices: [
      { id: "less_than_24h", label: "Less than 24 hours" },
      { id: "1_to_3_days", label: "1–3 days" },
      { id: "more_than_3_days", label: "More than 3 days" },
    ],
  },

  // Single_Choice (string response)
  {
    id: "q_smoking",
    questionText: "Do you currently smoke?",
    format: "Single_Choice",
    choices: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
  },

  // Single_Choice — but the response value is stored as a boolean.
  // Demonstrates that AnswerValue accepts boolean.
  {
    id: "q_consent",
    questionText:
      "Do you consent to share this information with your clinician?",
    format: "Single_Choice",
    choices: [
      { id: "true", label: "I consent" },
      { id: "false", label: "I do not consent" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Rules — exercise every operator, priority pattern, and multi-condition AND
// ---------------------------------------------------------------------------

export const rules: TraversalRule[] = [
  // ── From q_age ─────────────────────────────────────────────────────────
  // High-priority rule: under 18 → skip pregnancy question, jump to symptoms.
  {
    id: "r_age_under18",
    fromQuestionId: "q_age",
    conditions: [
      { questionId: "q_age", operator: "equals", value: "under_18" },
    ],
    nextQuestion: { type: "question", questionId: "q_symptoms" },
    priority: 10,
  },
  // Default fallback (empty conditions = unconditional).
  {
    id: "r_age_default",
    fromQuestionId: "q_age",
    conditions: [],
    nextQuestion: { type: "question", questionId: "q_pregnancy" },
    priority: 0,
  },

  // ── From q_pregnancy ───────────────────────────────────────────────────
  // Always advance to symptoms.
  {
    id: "r_pregnancy_default",
    fromQuestionId: "q_pregnancy",
    conditions: [],
    nextQuestion: { type: "question", questionId: "q_symptoms" },
    priority: 0,
  },

  // ── From q_symptoms ────────────────────────────────────────────────────
  // Urgent path: includes "chest_pain" → triage severity question.
  {
    id: "r_symptoms_chest_pain",
    fromQuestionId: "q_symptoms",
    conditions: [
      {
        questionId: "q_symptoms",
        operator: "includes",
        value: "chest_pain",
      },
    ],
    nextQuestion: { type: "question", questionId: "q_chest_pain_severity" },
    priority: 10,
  },
  // Default path: any other symptom selection → free-text question.
  {
    id: "r_symptoms_default",
    fromQuestionId: "q_symptoms",
    conditions: [],
    nextQuestion: { type: "question", questionId: "q_other_symptoms" },
    priority: 0,
  },

  // ── From q_chest_pain_severity ─────────────────────────────────────────
  // Multi-condition AND-rule.
  // Highest priority: elderly + non-mild chest pain → end (escalate to clinician).
  // This demonstrates a condition referencing an EARLIER question's answer.
  {
    id: "r_chest_high_risk_combo",
    fromQuestionId: "q_chest_pain_severity",
    conditions: [
      { questionId: "q_age", operator: "equals", value: "over_65" },
      {
        questionId: "q_chest_pain_severity",
        operator: "not_equals",
        value: "mild",
      },
    ],
    nextQuestion: { type: "end" },
    priority: 20,
  },
  // Severe chest pain alone → end.
  {
    id: "r_chest_severe",
    fromQuestionId: "q_chest_pain_severity",
    conditions: [
      {
        questionId: "q_chest_pain_severity",
        operator: "equals",
        value: "severe",
      },
    ],
    nextQuestion: { type: "end" },
    priority: 10,
  },
  // Default: continue to free-text.
  {
    id: "r_chest_default",
    fromQuestionId: "q_chest_pain_severity",
    conditions: [],
    nextQuestion: { type: "question", questionId: "q_other_symptoms" },
    priority: 0,
  },

  // ── From q_other_symptoms ──────────────────────────────────────────────
  // Always → pain level. Free-text response is NOT evaluated by the engine
  // (Part 3 territory: an LLM extractor would convert it to structured signals).
  {
    id: "r_other_default",
    fromQuestionId: "q_other_symptoms",
    conditions: [],
    nextQuestion: { type: "question", questionId: "q_pain_level" },
    priority: 0,
  },

  // ── From q_pain_level ──────────────────────────────────────────────────
  // Always → duration.
  {
    id: "r_pain_default",
    fromQuestionId: "q_pain_level",
    conditions: [],
    nextQuestion: { type: "question", questionId: "q_duration" },
    priority: 0,
  },

  // ── From q_duration ────────────────────────────────────────────────────
  // Long-duration symptoms → ask about smoking.
  {
    id: "r_duration_long",
    fromQuestionId: "q_duration",
    conditions: [
      {
        questionId: "q_duration",
        operator: "equals",
        value: "more_than_3_days",
      },
    ],
    nextQuestion: { type: "question", questionId: "q_smoking" },
    priority: 10,
  },
  // Default: skip smoking, go to consent.
  {
    id: "r_duration_default",
    fromQuestionId: "q_duration",
    conditions: [],
    nextQuestion: { type: "question", questionId: "q_consent" },
    priority: 0,
  },

  // ── From q_smoking ─────────────────────────────────────────────────────
  // Demonstrates not_equals: only ask "any other symptoms" path if NOT a smoker.
  // (Contrived — the point is just to exercise not_equals.)
  {
    id: "r_smoking_no",
    fromQuestionId: "q_smoking",
    conditions: [
      { questionId: "q_smoking", operator: "not_equals", value: "yes" },
    ],
    nextQuestion: { type: "question", questionId: "q_consent" },
    priority: 10,
  },
  {
    id: "r_smoking_default",
    fromQuestionId: "q_smoking",
    conditions: [],
    nextQuestion: { type: "question", questionId: "q_consent" },
    priority: 0,
  },

  // ── From q_consent ─────────────────────────────────────────────────────
  // Decline (boolean false) → end. Also demonstrates boolean-typed value.
  {
    id: "r_consent_declined",
    fromQuestionId: "q_consent",
    conditions: [{ questionId: "q_consent", operator: "equals", value: false }],
    nextQuestion: { type: "end" },
    priority: 10,
  },
  // Default: end (regardless of consent value).
  {
    id: "r_consent_default",
    fromQuestionId: "q_consent",
    conditions: [],
    nextQuestion: { type: "end" },
    priority: 0,
  },

  // ── Extra: not_includes example ────────────────────────────────────────
  // (Not wired into the live flow — exists purely so the fixture covers
  //  every operator. The engine should still evaluate it correctly when
  //  reached during testing.)
  {
    id: "r_symptoms_no_serious",
    fromQuestionId: "q_symptoms",
    conditions: [
      {
        questionId: "q_symptoms",
        operator: "not_includes",
        value: "shortness_of_breath",
      },
    ],
    nextQuestion: { type: "question", questionId: "q_other_symptoms" },
    priority: 1, // beats the default (0) but loses to chest-pain rule (10)
  },
];

// ---------------------------------------------------------------------------
// Form + version
// ---------------------------------------------------------------------------

export const version: Version = {
  id: "v_001",
  intakeFormId: "f_medical_intake",
  changeLog: "Initial version covering all question formats.",
  startQuestionId: "q_age",
  questions,
  author: "system",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  rules,
};

export const intakeForm: IntakeForm = {
  id: "f_medical_intake",
  name: "Medical Intake",
  activeVersionId: "v_001",
  author: "system",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

// ---------------------------------------------------------------------------
// Sample responses — covers every ResponseValue / status combination
// ---------------------------------------------------------------------------

export const responses: PatientResponse[] = [
  // string response — Single_Choice
  {
    id: "resp_1",
    sessionId: "sess_001",
    questionId: "q_age",
    response: "over_65",
    status: "answered",
    answeredAt: new Date("2026-04-25T10:00:00Z"),
  },
  // string response — Single_Choice
  {
    id: "resp_2",
    sessionId: "sess_001",
    questionId: "q_pregnancy",
    response: "no",
    status: "answered",
    answeredAt: new Date("2026-04-25T10:01:00Z"),
  },
  // string[] response — Multiple_Choice (includes chest_pain → urgent path)
  {
    id: "resp_3",
    sessionId: "sess_001",
    questionId: "q_symptoms",
    response: ["headache", "fever", "chest_pain"],
    status: "answered",
    answeredAt: new Date("2026-04-25T10:02:00Z"),
  },
  // string response — Single_Choice (severity)
  {
    id: "resp_4",
    sessionId: "sess_001",
    questionId: "q_chest_pain_severity",
    response: "moderate",
    status: "answered",
    answeredAt: new Date("2026-04-25T10:03:00Z"),
  },
  // long-form text — engine treats as inert (Part 3 LLM territory)
  {
    id: "resp_5",
    sessionId: "sess_001",
    questionId: "q_other_symptoms",
    response:
      "I've been feeling lightheaded for a few days, with occasional dizziness when standing up. Some pressure in my chest, comes and goes.",
    status: "answered",
    answeredAt: new Date("2026-04-25T10:04:00Z"),
  },
  // number response — demonstrates AnswerValue: number
  {
    id: "resp_6",
    sessionId: "sess_001",
    questionId: "q_pain_level",
    response: 7,
    status: "answered",
    answeredAt: new Date("2026-04-25T10:05:00Z"),
  },
  // null + skipped — patient chose not to answer
  {
    id: "resp_7",
    sessionId: "sess_001",
    questionId: "q_duration",
    response: null,
    status: "skipped",
    answeredAt: new Date("2026-04-25T10:06:00Z"),
  },
  // null + declined — patient explicitly refused (different from skipped)
  {
    id: "resp_8",
    sessionId: "sess_001",
    questionId: "q_smoking",
    response: null,
    status: "declined",
    answeredAt: new Date("2026-04-25T10:07:00Z"),
  },
  // boolean response — demonstrates AnswerValue: boolean
  {
    id: "resp_9",
    sessionId: "sess_001",
    questionId: "q_consent",
    response: true,
    status: "answered",
    answeredAt: new Date("2026-04-25T10:08:00Z"),
  },
];

// ---------------------------------------------------------------------------
// Sample session
// ---------------------------------------------------------------------------

export const session: PatientIntakeSession = {
  id: "sess_001",
  patientId: "patient_42",
  intakeFormId: "f_medical_intake",
  pinnedVersionId: "v_001",
  status: "in_progress",
  startedAt: new Date("2026-04-25T10:00:00Z"),
  completedAt: null,
  currentQuestionId: "q_consent",
};
