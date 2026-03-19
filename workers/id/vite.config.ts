import { defineConfig } from 'vite';

export default defineConfig(async () => {
  const plugins = [];
  if (!process.env.VITEST) {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    plugins.push(cloudflare());
  }
  return {
    plugins,
    server: {
      port: 8787,
    },
  };
});
