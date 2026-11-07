import { defineConfig } from "vite-plus";

export default defineConfig({
  server: { port: 8790 },
  test: { clearMocks: false },
});
