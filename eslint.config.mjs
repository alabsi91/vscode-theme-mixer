import pluginJs from "@eslint/js";
import markdown from "@eslint/markdown";
import compat from "eslint-plugin-compat";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import eslintPluginUnicorn from "eslint-plugin-unicorn";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tsEslint from "typescript-eslint";

export default defineConfig(
  // global ignores
  globalIgnores(["**/lib/", "**/dist/", "**/test/", "**/*.test.ts", "eslint.config.mjs"]),

  // prettier
  {
    files: ["**/*.md", "src/**/*.ts", "webview/**/*.ts"],
    extends: [eslintPluginPrettierRecommended],
    rules: {
      "prettier/prettier": "warn",
    },
  },

  // JavaScript and TypeScript
  {
    files: ["src/**/*.ts", "webview/**/*.ts"],
    extends: [
      pluginJs.configs.recommended,
      tsEslint.configs.recommendedTypeChecked,
      eslintPluginUnicorn.configs.recommended,
      compat.configs["flat/recommended"],
    ],
    /** @type {import("typescript-eslint").ConfigArray[number]["languageOptions"]} */
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      "no-prototype-builtins": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "unicorn/consistent-function-scoping": "off",
      "unicorn/prefer-spread": "off",
      "unicorn/no-nested-ternary": "off",
      "unicorn/import-style": "off",
      "unicorn/no-null": "off",
      "unicorn/prefer-string-replace-all": "off",
      "unicorn/number-literal-case": "off",
      "unicorn/no-this-outside-of-class": "off",
      "unicorn/prefer-https": "off",
      "unicorn/no-break-in-nested-loop": "off",
      "unicorn/consistent-class-member-order": "off",
      "unicorn/prefer-await": "off",
      "unicorn/no-collection-bracket-access": "off",
      "unicorn/prefer-minimal-ternary": "off",
      "unicorn/no-top-level-assignment-in-function": "off",
      "unicorn/no-useless-recursion": "off",
      "unicorn/prefer-ternary": "off",
      "unicorn/no-top-level-side-effects": "off",
      "unicorn/no-non-function-verb-prefix": "off",
      "unicorn/prefer-object-iterable-methods": "off",
      "unicorn/prefer-smaller-scope": "off",
      "unicorn/max-nested-calls": "off",
      "unicorn/no-useless-coercion": "off",
      "unicorn/prefer-number-coercion": "off",
      "unicorn/prefer-includes-over-repeated-comparisons": "off",
      "unicorn/filename-case": ["error", { case: "kebabCase" }],
    },
  },

  // MARKDOWN
  {
    files: ["**/*.md"],
    plugins: { markdown },
    language: "markdown/commonmark",
    rules: {
      "markdown/no-html": "off",
    },
  }
);
