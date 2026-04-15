import adapter from "@sveltejs/adapter-static";

const config = {
  compilerOptions: {
    runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
  },
  kit: {
    adapter: adapter({
      pages: "../dist",
      assets: "../dist",
      fallback: "index.html",
      precompress: false,
      strict: false,
    }),
  },
};

export default config;
