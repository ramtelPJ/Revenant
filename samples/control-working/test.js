const assert = require("node:assert");
const hello = require("./src/index.js");

(async () => {
  assert.strictEqual(await hello("world"), "Hello, world!");
  console.log("ok: greeting works");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
