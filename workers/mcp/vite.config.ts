import type { UserConfig } from "vite-plus";
import { defineConfig } from "vite-plus";

export default defineConfig(async (): Promise<UserConfig> => {
  const plugins = process.env.VITEST ? [] : (await import("@cloudflare/vite-plugin")).cloudflare();
  return {
    plugins: plugins as UserConfig["plugins"],
    server: { port: 8790 },
  };
});
