import { AppError } from "./respond";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id must be a UUID. Anything else is the caller's mistake (400), and never reaches a query. */
export function idParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new AppError("VALIDATION_FAILED", 400, "That link isn't valid.", { [name]: "Must be a valid id." });
  }
  return value;
}
