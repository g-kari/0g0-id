import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  outDir: "../dist/client",
  vite: {
    plugins: [tailwindcss() as any],
  },
});
