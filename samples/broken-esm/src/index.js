const { greet } = require("esm-greeter");

module.exports = function hello(name) {
  return greet(name);
};
