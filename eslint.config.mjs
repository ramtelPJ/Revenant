import next from "eslint-config-next";

const config = [...next, { ignores: ["samples/**", "data/**", ".next/**", "context/**"] }];
export default config;
