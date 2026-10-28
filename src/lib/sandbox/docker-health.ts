import { DOCKER_CANDIDATES, runQuiet } from "./docker.ts";

export type DockerHealth = { available: boolean; imagePresent: boolean; image: string };
/** Resolves true only if the command exits 0. Replaceable in tests. */
export type Run = (bin: string, args: string[]) => Promise<boolean>;

/** Is the Docker CLI there, is the engine running, and is the sandbox image already pulled? Never throws. */
export async function checkDocker(image: string, run: Run = (bin, args) => runQuiet(bin, args, timeoutMs), timeoutMs = 5000): Promise<DockerHealth> {
  for (const bin of DOCKER_CANDIDATES) {
    if (!(await run(bin, ["--version"]))) continue;
    if (!(await run(bin, ["info"]))) break; // CLI found, engine stopped
    return { available: true, imagePresent: await run(bin, ["image", "inspect", image]), image };
  }
  return { available: false, imagePresent: false, image };
}
