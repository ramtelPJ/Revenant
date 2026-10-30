import { START_DOCKER_FIX, START_OLLAMA_FIX, pullImageFix, pullModelFix } from "./fixes";

export type Health = {
  ollama: { reachable: boolean; modelInstalled: boolean; model: string };
  docker: { available: boolean; imagePresent: boolean; image: string };
  limits?: { maxArchiveMb: number; maxProjectMb: number; sandboxMemoryMb?: number; sandboxCpus?: number; checkTimeoutSec?: number };
};
export type Problem = { id: "ollama" | "model" | "docker" | "image"; title: string; consequence: string; fix: string };

/** What is wrong, what it costs the user, and how to fix it. Empty when everything is ready. */
export function healthProblems(health: Health): Problem[] {
  const problems: Problem[] = [];
  const { ollama, docker } = health;

  if (!ollama.reachable) {
    problems.push({ id: "ollama", title: "The local AI (Ollama) is not running", consequence: "Project overviews, diagnosis and repair suggestions are unavailable.", fix: START_OLLAMA_FIX });
  } else if (!ollama.modelInstalled) {
    problems.push({ id: "model", title: `The model ${ollama.model} is not installed`, consequence: "Project overviews, diagnosis and repair suggestions are unavailable.", fix: pullModelFix(ollama.model) });
  }

  if (!docker.available) {
    problems.push({ id: "docker", title: "Docker is not available", consequence: "Checks cannot run, so no repair can be verified; results stay Unverified.", fix: START_DOCKER_FIX });
  } else if (!docker.imagePresent) {
    problems.push({ id: "image", title: `The sandbox image ${docker.image} is not installed`, consequence: "Checks cannot run, so no repair can be verified; results stay Unverified.", fix: pullImageFix(docker.image) });
  }
  return problems;
}

/** Splits `text with \`code\` parts` into plain and code pieces, so they can be rendered as text, never as HTML. */
export function splitInlineCode(text: string): { text: string; code: boolean }[] {
  return text.split("`").map((piece, i) => ({ text: piece, code: i % 2 === 1 })).filter((piece) => piece.text !== "");
}

/** The banners are for the working screens; the locked page explains itself. */
export const showsBanners = (pathname: string | null) => pathname !== "/locked";
