const assert = require("node:assert");
const add = require("./src/index.js");
assert.strictEqual(add(2, 3), 5);
console.log("ok");
