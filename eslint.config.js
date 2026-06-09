import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "session/", "logs/", "uploads/", "coverage/"],
  },
  js.configs.recommended,
  // Default — ESM + Node globals (includes console/process)
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.nodeBuiltin,
        // Browser globals needed inside page.evaluate() callbacks
        window: "readonly",
        document: "readonly",
        HTMLCanvasElement: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-unreachable": "warn",
      "no-await-in-loop": "off",
      "no-prototype-builtins": "off",
    },
  },
  // Scripts that still use CommonJS (test_direct_qwen.js)
  {
    files: ["scripts/test_direct_qwen.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
      globals: {
        ...globals.nodeBuiltin,
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
];
