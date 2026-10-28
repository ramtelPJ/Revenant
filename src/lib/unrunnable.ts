/** Why a check could not run, in words for the person using the app. Safe for the browser and the server. */
export function explainUnrunnable(reason: string | null, image = "the sandbox image"): string {
  switch (reason) {
    case "docker_missing":
      return "Docker was not found, so the check could not run. Install Docker, then try again.";
    case "docker_not_running":
      return "Docker is installed but not running, so the check could not run. Start Docker, then try again.";
    case "image_missing":
      return `The sandbox image (${image}) is not installed. Pull it once while online, then try again.`;
    case "script_missing":
      return "This project has no script for that check, so there is nothing to run.";
    case "no_node_modules":
      return "This project's dependencies are not installed, and checks run offline. Import it with its node_modules folder.";
    case "cancelled":
      return "The check was cancelled.";
    case "copy_failed":
      return "The project could not be prepared for the sandbox.";
    case "in_progress":
    case "interrupted":
      return "This check did not finish (Revenant was stopped while it ran), so it counts as neither a pass nor a failure.";
    default:
      return "The check could not run.";
  }
}
