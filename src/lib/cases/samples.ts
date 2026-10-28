import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const sampleFile = z.object({ name: z.string().min(1).max(120), description: z.string().min(1).max(500) });
export type SampleInfo = { id: string; name: string; description: string };

/** The samples on disk. Only `sample.json` is read; the answer key (`expected.json`) is never touched. */
export function listSamples(samplesDir: string): SampleInfo[] {
  let names: string[];
  try {
    names = readdirSync(/*turbopackIgnore: true*/ samplesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const samples: SampleInfo[] = [];
  for (const id of names.sort()) {
    try {
      const parsed = sampleFile.parse(JSON.parse(readFileSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ samplesDir, id, "sample.json"), "utf8")));
      samples.push({ id, ...parsed });
    } catch {
      /* a folder without a valid sample.json is not a sample */
    }
  }
  return samples;
}
