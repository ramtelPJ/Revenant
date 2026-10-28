module.exports = async function hello(name) {
  const { greet } = await import("esm-greeter");
  return greet(name);
};
