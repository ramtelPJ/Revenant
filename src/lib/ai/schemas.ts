import { z } from "zod";
import { FINDING_CATEGORIES } from "@/lib/db/schema";

// What the local model is asked to produce. Each schema is sent to Ollama as its JSON schema and checked again here.
// Shapes stay flat and small because small models follow those best. The label of a finding is not in any of them:
// it is decided in code (label.ts), so the model cannot claim "confirmed".

const text = (max: number) => z.string().trim().min(1).max(max);
const line = z.number().int().positive();

export const overviewSchema = z.object({
  purpose: text(800),
  how_to_run: text(400),
  key_files: z.array(z.object({ path: text(300), reason: text(300) })).max(8),
});
export type Overview = z.infer<typeof overviewSchema>;

/** One flat shape for both kinds (only `kind` is required), checked per kind by evidence.ts. */
export const evidenceSchema = z.object({
  kind: z.enum(["file", "log"]),
  path: z.string().max(300).optional(),
  startLine: line.optional(),
  endLine: line.optional(),
  quote: z.string().max(400).optional(),
  excerpt: z.string().max(400).optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const findingSchema = z.object({
  title: text(160),
  explanation: text(1500),
  category: z.enum(FINDING_CATEGORIES),
  actionable: z.boolean(),
  evidence: z.array(evidenceSchema).max(6),
});

/** The model picks from numbered evidence the app built (`cites`), so it cannot invent a citation. */
export const diagnosisSchema = z.object({
  title: text(160),
  explanation: text(1500),
  category: z.enum(FINDING_CATEGORIES),
  actionable: z.boolean(),
  cites: z.array(z.number().int().positive()).max(6),
});

export const patchSchema = z.object({
  rationale: text(600),
  edits: z
    .array(z.object({ path: text(300), search: z.string().min(1).max(4000), replace: z.string().max(4000) }))
    .min(1)
    .max(5),
});
