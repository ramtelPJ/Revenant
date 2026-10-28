import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const SOURCE_KINDS = ["sample", "folder", "archive"] as const;
export const STAGES = ["imported", "analyzed", "diagnosed", "patched", "verified"] as const;
export const VERDICTS = ["resurrected", "partially_repaired", "failed", "unverified"] as const;
export const JOB_KINDS = ["analyze", "diagnose", "propose_patch", "verify"] as const;
export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const CHECK_PHASES = ["baseline", "after"] as const;
export const CHECK_KINDS = ["test", "build", "start"] as const;
export const CHECK_TARGETS = ["original", "working"] as const;
export const CHECK_STATUSES = ["passed", "failed", "timed_out", "unrunnable"] as const;
export const FINDING_LABELS = ["confirmed_by_check", "supported_by_files", "hypothesis", "no_failure_found"] as const;
export const FINDING_CATEGORIES = [
  "module_format",
  "removed_api",
  "bad_path_or_config",
  "missing_file",
  "dependency_version",
  "runtime_error",
  "other",
] as const;
export const PATCH_STATUSES = ["proposed", "approved", "rejected", "superseded"] as const;

const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());
const now = (name: string) => integer(name).notNull().$defaultFn(() => Date.now());

export const cases = sqliteTable(
  "cases",
  {
    id: id(),
    name: text("name").notNull(),
    sourceKind: text("source_kind", { enum: SOURCE_KINDS }).notNull(),
    sourceLabel: text("source_label").notNull(),
    stage: text("stage", { enum: STAGES }).notNull().default("imported"),
    sizeBytes: integer("size_bytes").notNull(),
    fileCount: integer("file_count").notNull(),
    verdict: text("verdict", { enum: VERDICTS }),
    verdictReason: text("verdict_reason"),
    verdictAt: integer("verdict_at"),
    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [
    // serves the Case Files list (newest first); SQLite scans an ascending index backwards
    index("cases_updated_idx").on(t.updatedAt),
    check("cases_source_kind_check", oneOf("source_kind", SOURCE_KINDS)),
    check("cases_stage_check", oneOf("stage", STAGES)),
    check("cases_verdict_check", sql`verdict IS NULL OR ${oneOf("verdict", VERDICTS)}`),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: JOB_KINDS }).notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    progressNote: text("progress_note"),
    stepsJson: text("steps_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: now("created_at"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("jobs_case_idx").on(t.caseId, t.createdAt),
    // at most one queued/running job per case
    uniqueIndex("jobs_one_active_idx")
      .on(t.caseId)
      .where(sql`status IN ('queued', 'running')`),
    check("jobs_kind_check", oneOf("kind", JOB_KINDS)),
    check("jobs_status_check", oneOf("status", JOB_STATUSES)),
  ],
);

export const analyses = sqliteTable("analyses", {
  id: id(),
  caseId: text("case_id")
    .notNull()
    .unique()
    .references(() => cases.id, { onDelete: "cascade" }),
  inventoryJson: text("inventory_json").notNull(),
  summaryJson: text("summary_json"),
  model: text("model"),
  createdAt: now("created_at"),
});

export const errorLogs = sqliteTable(
  "error_logs",
  {
    id: id(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: now("created_at"),
  },
  (t) => [index("error_logs_case_idx").on(t.caseId, t.createdAt)],
);

// findings -> check_runs -> patches -> findings is a reference cycle, so one edge
// carries an explicit AnySQLiteColumn type.
export const findings = sqliteTable(
  "findings",
  {
    id: id(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    // set by ai/label.ts in code, never by the model
    label: text("label", { enum: FINDING_LABELS }).notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    category: text("category", { enum: FINDING_CATEGORIES }),
    evidenceJson: text("evidence_json").notNull(),
    // how many of the model's citations could not be verified and were left out
    droppedCitations: integer("dropped_citations").notNull().default(0),
    checkRunId: text("check_run_id").references((): AnySQLiteColumn => checkRuns.id, { onDelete: "set null" }),
    model: text("model"),
    createdAt: now("created_at"),
  },
  (t) => [
    index("findings_case_idx").on(t.caseId, t.createdAt),
    check("findings_label_check", oneOf("label", FINDING_LABELS)),
    check("findings_category_check", sql`category IS NULL OR ${oneOf("category", FINDING_CATEGORIES)}`),
  ],
);

export const patches = sqliteTable(
  "patches",
  {
    id: id(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    rationale: text("rationale").notNull(),
    editsJson: text("edits_json").notNull(),
    diffText: text("diff_text").notNull(),
    filesAffectedJson: text("files_affected_json").notNull(),
    status: text("status", { enum: PATCH_STATUSES }).notNull().default("proposed"),
    model: text("model").notNull(),
    createdAt: now("created_at"),
    decidedAt: integer("decided_at"),
  },
  (t) => [
    index("patches_case_idx").on(t.caseId, t.createdAt),
    // at most one approved patch per case
    uniqueIndex("patches_one_approved_idx")
      .on(t.caseId)
      .where(sql`status = 'approved'`),
    check("patches_status_check", oneOf("status", PATCH_STATUSES)),
  ],
);

export const checkRuns = sqliteTable(
  "check_runs",
  {
    id: id(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    patchId: text("patch_id").references(() => patches.id, { onDelete: "cascade" }),
    phase: text("phase", { enum: CHECK_PHASES }).notNull(),
    checkKind: text("check_kind", { enum: CHECK_KINDS }).notNull(),
    commandLabel: text("command_label").notNull(),
    target: text("target", { enum: CHECK_TARGETS }).notNull(),
    status: text("status", { enum: CHECK_STATUSES }).notNull(),
    exitCode: integer("exit_code"),
    outputExcerpt: text("output_excerpt"),
    unrunnableReason: text("unrunnable_reason"),
    durationMs: integer("duration_ms"),
    limitsJson: text("limits_json").notNull(),
    // no row can exist without the user's consent
    consentedAt: integer("consented_at").notNull(),
    startedAt: now("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("check_runs_case_idx").on(t.caseId, t.startedAt),
    check("check_runs_phase_check", oneOf("phase", CHECK_PHASES)),
    check("check_runs_kind_check", oneOf("check_kind", CHECK_KINDS)),
    check("check_runs_target_check", oneOf("target", CHECK_TARGETS)),
    check("check_runs_status_check", oneOf("status", CHECK_STATUSES)),
    // an `after` run always belongs to a patch; a `baseline` run never does
    check("check_runs_phase_patch_check", sql`(phase = 'after') = (patch_id IS NOT NULL)`),
  ],
);
