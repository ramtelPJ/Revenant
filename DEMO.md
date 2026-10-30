# Revenant demo script

About 6 minutes. Everything runs on this laptop: a local model (Ollama), a Docker sandbox, no internet needed after setup.

**The one idea to land:** Revenant never says "fixed" because an AI said so. It says "fixed" only when the project's own failing check goes from fail to pass inside a sandbox.

## Before you go on (10 minutes ahead)

1. Quit heavy apps. This machine has 8 GB of memory and is tight.
2. Open Docker Desktop and wait until it says running.
3. `npm run setup-check` must print "Setup is complete" (model `qwen2.5-coder:3b`, Docker, image `node:lts-slim`).
4. `npm run build` if the code changed since the last build, then `npm run revenant`. Use the link it opens; it works once.
5. Warm the model: do one throwaway Start Investigation on any sample so the first on-stage call isn't a cold load (10-30 s). Then delete that case from "Recent investigations".
6. Optional proof of offline: turn Wi-Fi off now. Nothing in the demo should change.
7. Keep a pre-run case in history (see Fallback).

## Click path (sample: `broken-missing-main`)

This is the one sample the model has repaired in real runs (see numbers). Lead with it.

| # | Do | Say |
|---|---|---|
| 1 | Landing page, click **Launch App**. | "Local-first. The server is bound to 127.0.0.1 and the link I opened works once." |
| 2 | On the import page, find `broken-missing-main`, click **Load sample →**. | "A small Node project whose tests fail. You can also import a folder or a zip." |
| 3 | Click **Start Investigation**. | "The local model reads the project and writes an overview. Each claim cites a file; claims that don't check out are dropped in code." |
| 4 | Tick **I allow this project's code to run in the sandbox**, click **Run the check**. | "Nothing runs until I allow it, and the tick resets every time. The sandbox has no network, a read-only filesystem, a memory cap and a timeout." |
| 5 | Open the autopsy (link in the panel). Point at the label on the finding. | "The label comes from code, not from the model: *Confirmed by Check* means a real run failed this way. The real error is shown: `MODULE_NOT_FOUND` for `src/main.js`." |
| 6 | Click **Propose Repair**. Read the diff aloud. | "One AI-written patch, at most 3 files and 5 edits. It is a suggestion. Nothing is changed yet." |
| 7 | Click **Approve Patch**. | "I am the gate. Approval builds a separate working copy; the original is read-only and never touched." |
| 8 | Click **Continue to Verification**, tick the consent box, click **Run Checks**. | "It runs the failing check on the original, then on the patched copy, in the sandbox." |
| 9 | Click **Open the Report**. | "Verdict **Resurrected**, with the failing run before and the passing run after. The verdict is computed by plain code from those runs." |
| 10 | Point at the AI-contribution section and the disclaimer. | "The report says which steps the AI did and which were plain code. Passing a check is not a full audit." |

## The honesty moment (control project, 1 minute)

Load `control-working` and do steps 3-4. Expected: **No failure found**; Propose Repair is not offered.

Say: "This project already works. A tool that always has an answer would invent a bug here. Revenant reports nothing wrong, and it can never mark a project Resurrected without a passing check."

Optional: on any case with an approved patch, **Skip Verification** gives **Unverified**, not success.

## If the model's patch fails (say it plainly, don't hide it)

`broken-esm` and `broken-removed-api` are diagnosed reasonably but the model's patch usually does not fix them. If you show one, the expected result is an honest **Failed** verdict with the before/after runs. Say: "The AI suggestions are not guaranteed repairs. That is exactly why verification exists." You can click **Regenerate Suggestion** to try again. Variance is real, so don't promise a result.

## Real numbers (quote only these)

From `npm run eval`, model `qwen2.5-coder:3b`, 3 runs per broken sample (9 broken runs) plus 3 control runs, latest run (`data/eval-2026-10-29T02-12-17-032Z.json`):

| Measure | Result | Overview target |
|---|---|---|
| Failure identified (category and cited file) | 3 of 9 | 4 of 5 |
| Verified repair (failing check passes after approved patch) | 2 of 9 | 3 of 5 |
| Control reported healthy | 3 of 3 | n/a |
| False "Resurrected" | 0 | zero |

By sample: `broken-missing-main` repaired in 2 of 3 runs; `broken-esm` and `broken-removed-api` not repaired. Valid patches were produced in 8 of 9 runs, but a valid patch is not a fix.

Be upfront:
- Both quality targets are **not met** with a 3B model. A 7B model does not fit this 8 GB machine.
- The prompt was tuned on these same three samples, so the identification gain is in-sample.
- The result that matters most holds: no false successes, control always correct.
- Case activation, return use, and offline completion (3 runs with the network off) are not measured yet.

## Talking points

- **Real:** local model via Ollama, Docker sandbox, actual check output, verdict computed from stored runs.
- **Not guaranteed:** the AI's diagnosis and patch. They are suggestions a human approves.
- **Safe by design:** consent before any code runs; sandbox with no network; original never modified; one patch, small and reviewable.
- **Scope:** one supported project type (Node.js), narrow repairs. Not a refactoring or security tool.

## Fallback plan

| If | Do |
|---|---|
| Model is slow or fails ("AI unavailable") | Wait once. The app shows a plain message and a retry; the checks themselves still work. Switch to the pre-run case. |
| Docker is not running | The app says so and disables the run buttons. Start Docker Desktop, or switch to the pre-run case. |
| Patch is invalid or doesn't fix it | Click **Regenerate Suggestion** once. Then present the honest Failed/Unverified result, or switch to the pre-run case. |
| Everything is broken | Play the recorded video. |

**Pre-run case:** before the demo, run `broken-missing-main` to Resurrected once and leave it in "Recent investigations" so you can open its report instantly.

**Fallback video (you record this; I can't):** one screen recording, 3-5 minutes, of a successful `broken-missing-main` run following the click path above, then the `control-working` "No failure found" moment. Record it after a rehearsal where it actually reaches Resurrected, with audio off or narrated. Keep the file outside the repo and test that it plays.

## Not yet done

- No full rehearsal from this script has been done by a person, and the click path has not been verified in a real browser (INT-001B).
- The offline run with the network disconnected (DEPLOY-002) has not been done.
- The fallback video does not exist yet.
