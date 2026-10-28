export type OllamaHealth = { reachable: boolean; modelInstalled: boolean; model: string };

/** Is Ollama answering, and is the model pulled? Never throws: any failure is "not reachable". */
export async function checkOllama(url: string, model: string, timeoutMs = 3000): Promise<OllamaHealth> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { reachable: false, modelInstalled: false, model };
    const body = (await response.json()) as { models?: { name?: string; model?: string }[] };
    // a bare name like "llama3" means "llama3:latest"
    const wanted = model.includes(":") ? model : `${model}:latest`;
    const modelInstalled = (body.models ?? []).some((m) => [m.name, m.model].some((n) => n === model || n === wanted));
    return { reachable: true, modelInstalled, model };
  } catch {
    return { reachable: false, modelInstalled: false, model };
  }
}
