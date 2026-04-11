import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*.{ts,tsx,js,jsx}": "vp check --fix",
  },
  fmt: {},
  lint: {
    options: { typeAware: true, typeCheck: true },
    rules: {
      "no-control-regex": "off",
    },
    overrides: [
      {
        files: ["**/*.test.ts"],
        rules: {
          "typescript/unbound-method": "off",
        },
      },
    ],
  },
});
