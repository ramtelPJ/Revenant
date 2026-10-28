# Samples

Small projects for trying Revenant. Run `npm run prepare-samples` once (it installs each sample's dependencies)
so they can be checked offline.

| Sample | State | Expected result |
|---|---|---|
| broken-esm | `npm test` fails: `require()` of an ESM-only dependency that uses top-level await | Fix is one file: `src/index.js` |
| control-working | `npm test` passes | Revenant reports "no failure found" |

`sample.json` is shown in the UI. `expected.json` is the answer key used only by the benchmark script; the importer does
not copy either file into a case. `vendor/esm-greeter-1.0.0.tgz` is a tiny ESM-only package (built with `npm pack`) so no
registry access is needed.
