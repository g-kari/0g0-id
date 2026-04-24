export function createAstroConfig(importMetaUrl: string, plugins: unknown[]) {
  return {
    output: "static" as const,
    outDir: "../dist/client",
    vite: {
      plugins: plugins as any[],
      resolve: {
        alias: {
          "@0g0-id/api-types": new URL("../../../packages/shared/src/api-types.ts", importMetaUrl)
            .pathname,
        },
      },
    },
  };
}
