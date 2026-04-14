import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
  },
  kit: {
    adapter: adapter({
      pages: "../dist",
      assets: "../dist",
      fallback: "200.html",
      precompress: false,
      strict: false,
    }),
  },
};

export default config;
