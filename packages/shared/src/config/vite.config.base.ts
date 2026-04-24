import type { UserConfig } from "vite-plus";
import { defineConfig } from "vite-plus";

export function createViteConfig(port: number) {
  return defineConfig(async (): Promise<UserConfig> => {
    const plugins = process.env.VITEST
      ? []
      : (await import("@cloudflare/vite-plugin")).cloudflare();
    return {
      plugins: plugins as UserConfig["plugins"],
      server: { port },
    };
  });
}
