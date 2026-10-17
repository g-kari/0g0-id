import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import { createAstroConfig } from "../../../packages/shared/src/config/astro.config.base.js";

export default defineConfig(createAstroConfig(import.meta.url, [tailwindcss()]));
