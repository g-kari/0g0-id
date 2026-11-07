import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    clearMocks: false,
    environment: "node",
  },
});
