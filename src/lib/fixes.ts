// Fix instructions shared by `npm run setup-check` and the in-app banner, so the two always say the same thing.
export const START_OLLAMA_FIX = "Start Ollama (open the Ollama app, or run `ollama serve`)";
export const START_DOCKER_FIX = "Start Docker, and make sure the `docker` command works in your terminal";
export const pullModelFix = (model: string) => `Run \`ollama pull ${model}\` (needs internet once)`;
export const pullImageFix = (image: string) => `Run \`docker pull ${image}\` (needs internet once)`;
