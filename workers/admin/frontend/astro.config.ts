import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  output: "static",
  outDir: "../dist/client",
  vite: {
    plugins: [tailwindcss() as any],
    resolve: {
      alias: {
        "@0g0-id/api-types": new URL("../../../packages/shared/src/api-types.ts", import.meta.url)
          .pathname,
      },
    },
  },
});
