import { checkOllama } from "@/lib/ai/ollama-health";
import { getEnv } from "@/lib/env";
import { guardApi } from "@/lib/http/guard";
import { handle, ok } from "@/lib/http/respond";
import { checkDocker } from "@/lib/sandbox/docker-health";

export const GET = handle(async (request) => {
  guardApi(request);
  const env = getEnv();
  // both checks answer "not available" instead of failing, so the app can say what is missing
  const [ollama, docker] = await Promise.all([checkOllama(env.OLLAMA_URL, env.OLLAMA_MODEL), checkDocker(env.SANDBOX_IMAGE)]);
  return ok({ ollama, docker, limits: { maxArchiveMb: env.MAX_ARCHIVE_MB, maxProjectMb: env.MAX_PROJECT_MB } });
});
