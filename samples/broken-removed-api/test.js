const assert = require("node:assert");
const postUrl = require("./src/index.js");

assert.strictEqual(postUrl("Hello, World!"), "/posts/hello-world");
assert.strictEqual(postUrl("  Dead code, second life  "), "/posts/dead-code-second-life");
console.log("ok: post urls work");
