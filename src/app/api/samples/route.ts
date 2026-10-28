import path from "node:path";
import { listSamples } from "@/lib/cases/samples";
import { guardApi } from "@/lib/http/guard";
import { handle, ok } from "@/lib/http/respond";

export const GET = handle(async (request) => {
  guardApi(request);
  return ok(listSamples(path.resolve(/*turbopackIgnore: true*/ process.cwd(), "samples")));
});
