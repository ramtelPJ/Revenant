# Samples

Small projects for trying Revenant. Run `npm run prepare-samples` once (it installs each sample's dependencies)
so they can be checked offline.

| Sample | State | Expected result |
|---|---|---|
| broken-esm | `npm test` fails: `require()` of an ESM-only dependency that uses top-level await | Fix is one file: `src/index.js` |
| broken-removed-api | `npm test` fails: `textkit.slugify is not a function` (the pinned `textkit` 2.0.0 removed it) | Fix is one file: `src/index.js` (use `toSlug`) |
| broken-missing-main | `npm test` fails: `MODULE_NOT_FOUND` (`package.json` `main` still points at the renamed `src/main.js`) | Fix is one file: `package.json` (`main` -> `src/index.js`) |
| control-working | `npm test` passes | Revenant reports "no failure found" |

`sample.json` is shown in the UI. `expected.json` is the answer key used only by the benchmark script; the importer does
not copy either file into a case. `vendor/*.tgz` are tiny packages (built with `npm pack`: an ESM-only `esm-greeter`, and `textkit` 2.0.0 without `slugify`) so no
registry access is needed. `broken-missing-main` has no dependencies.
