const assert = require("node:assert");
const add = require(".");

assert.strictEqual(add(2, 3), 5);
assert.strictEqual(add(-1, 1), 0);
console.log("ok: add works");
