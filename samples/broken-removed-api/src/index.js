const textkit = require("textkit");

module.exports = function postUrl(title) {
  return "/posts/" + textkit.slugify(title);
};
