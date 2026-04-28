import { plugin as fedifyLint } from "@fedify/lint";
import { defineConfig } from "oxlint";

const fedifyRecommendedRules = Object.fromEntries(
  Object.entries(fedifyLint.configs.recommended.rules).map(
    ([ruleName, severity]) => [
      ruleName.replace("@fedify/lint/", "fedify/"),
      severity,
    ],
  ),
) as Record<string, "warn" | "error">;

const disabledFedifyRules = Object.fromEntries(
  Object.keys(fedifyRecommendedRules).map((ruleName) => [ruleName, "off"]),
) as Record<string, "off">;

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc", "jsx-a11y", "vitest"],
  jsPlugins: [
    { name: "fedify", specifier: "./tools/oxlint-fedify-plugin.mjs" },
  ],
  ignorePatterns: [
    ".github/**/*",
    "docs/**/*",
    "docs/.astro/**/*",
    "docs/dist/**/*",
    "docs/node_modules/**/*",
    "drizzle/**/*",
    "node_modules/**/*",
    "src/public/**/*",
  ],
  env: {
    browser: true,
    node: true,
    es2024: true,
  },
  rules: {
    "no-unused-vars": [
      "warn",
      {
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
      },
    ],
    "jest/no-conditional-expect": "off",
    "jest/no-disabled-tests": "off",
    "jest/valid-describe-callback": "off",
    "jest/valid-expect": "off",
    "jsx-a11y/no-redundant-roles": "off",
    "jsx-a11y/label-has-associated-control": "off",
    "jsx-a11y/prefer-tag-over-role": "off",
    "vitest/require-mock-type-parameters": "off",
    "typescript/no-non-null-assertion": "off",
    "no-shadow-restricted-names": "off",
  },
  overrides: [
    {
      files: ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
      rules: fedifyRecommendedRules,
    },
    {
      files: ["src/**/*.test.{ts,tsx,js,jsx,mjs,cjs}", "tests/**/*.{ts,tsx}"],
      env: {
        vitest: true,
      },
      rules: disabledFedifyRules,
    },
  ],
});
