import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const [major, minor, patch] = process.versions.node.split(".").map(Number);
assert(
  major > 22 || (major === 22 && (minor > 23 || (minor === 23 && patch >= 4))),
  "Frontend Prism requires Node >=22.23.4",
);

async function assertSafeCode(html, expected, label, language, highlighted, shiki = false) {
  const window = new Window({
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      enableCSSFileLoading: false,
      enableImageFileLoading: false,
      enableIframePageLoading: false,
    },
  });
  try {
    const container = window.document.createElement("div");
    container.innerHTML = html;
    assert.equal(container.children.length, 1, `${label}: one fenced block`);
    assert.equal(container.firstElementChild?.tagName, "PRE", `${label}: pre wrapper`);
    assert.equal(container.querySelectorAll("pre").length, 1, `${label}: one pre element`);
    assert.equal(container.querySelectorAll("code").length, 1, `${label}: one code element`);
    const code = container.querySelector("pre > code");
    assert.ok(code, `${label}: code is a direct child of pre`);
    assert.equal(code.textContent, expected, `${label}: exact code text`);
    const pre = container.firstElementChild;
    assert.equal(pre.textContent, expected, `${label}: no injected text inside pre`);
    assert.equal(container.childNodes.length, 2, `${label}: pre and terminal newline only`);
    assert.equal(container.childNodes[0], pre, `${label}: pre is first node`);
    assert.equal(
      container.childNodes[1].nodeType,
      window.Node.TEXT_NODE,
      `${label}: terminal text node`,
    );
    assert.equal(
      container.childNodes[1].textContent,
      "\n",
      `${label}: exactly one terminal newline`,
    );
    for (const element of container.querySelectorAll("*")) {
      assert.ok(
        (highlighted ? ["PRE", "CODE", "SPAN"] : ["PRE", "CODE"]).includes(element.tagName),
        `${label}: unexpected element`,
      );
      if (element.tagName === "SPAN") {
        assert.ok(code.contains(element), `${label}: highlighting span belongs to code`);
      }
      for (const attribute of element.attributes) {
        assert.ok(!/^on/i.test(attribute.name), `${label}: event handler attribute`);
        assert.ok(
          ["class", "data-language"].includes(attribute.name) ||
            (shiki && ["style", "tabindex"].includes(attribute.name)),
          `${label}: unexpected attribute`,
        );
      }
    }
    if (language !== undefined) {
      assert.ok(code.getAttribute("class") === `language-${language}`, `${label}: language class`);
      assert.equal(
        pre.getAttribute("class"),
        `language-${language}`,
        `${label}: pre language class`,
      );
      assert.equal(pre.getAttribute("data-language"), language);
    }
    if (highlighted) assert.ok(code.querySelector("span"), `${label}: syntax highlighting`);
  } finally {
    await window.happyDOM.abort();
    window.close();
  }
}

const attack = '<script>throw 0</script><img src=x onerror="throw 0"> & <tag> "quoted"';
const prismCases = [
  { name: "unknown code payload", lang: "unknown-regression-language", code: attack },
  { name: "double quote language", lang: 'unknown"onmouseover="throw0', code: "safe & <text>" },
  { name: "angle delimiter language", lang: 'unknown"><img/src=x/onerror=throw0>', code: "safe" },
  { name: "single quote language", lang: "unknown'><script>throw0</script>", code: "safe" },
  {
    name: "entity decoded language",
    lang: "x&quot;&#32;onmouseover=&quot;void(0)",
    decoded: 'x" onmouseover="void(0)',
    code: "safe & <text>",
  },
  { name: "TypeScript alias", lang: "ts", code: 'const message: string = "<&>";', tokens: true },
  { name: "TypeScript", lang: "typescript", code: "const count: number = 1;", tokens: true },
  {
    name: "Astro",
    lang: "astro",
    code: '<div class="message">Hello &amp; world</div>',
    tokens: true,
  },
  { name: "plaintext", lang: "plaintext", code: attack },
  { name: "absent language", lang: "", code: attack },
];
const fence = (lang, code, marker = "```") => `${marker}${lang}\n${code}\n${marker}\n`;

const selectedWorker = process.argv[2];
assert.ok(["admin", "user"].includes(selectedWorker), "Pass one frontend: admin or user");
for (const worker of [selectedWorker]) {
  const frontend = join(process.cwd(), "workers", worker, "frontend");
  const requireFrontend = createRequire(join(frontend, "package.json"));
  assert.equal(read(join(frontend, "package.json")).engines.node, ">=22.23.4");
  const astroManifest = requireFrontend.resolve("astro/package.json");
  const astroVersion = read(astroManifest).version;
  assert.match(astroVersion, /^7\./, "frontend astro must stay on the 7.x line");
  const requireAstro = createRequire(astroManifest);
  const satteriEntry = realpathSync(requireAstro.resolve("@astrojs/markdown-satteri"));
  const satteriManifest = read(join(dirname(satteriEntry), "../package.json"));
  assert.equal(satteriManifest.name, "@astrojs/markdown-satteri");
  assert.match(satteriManifest.version, /^0\.4\./, "@astrojs/markdown-satteri must stay on 0.4.x");
  const requireSatteri = createRequire(satteriEntry);
  const prismEntry = realpathSync(requireSatteri.resolve("@astrojs/prism/dist/highlighter"));
  const prismManifest = read(join(dirname(prismEntry), "../package.json"));
  assert.equal(prismManifest.name, "@astrojs/prism");
  assert.match(prismManifest.version, /^4\./, "@astrojs/prism must stay on 4.x");
  console.log(`[frontend-markdown] ${worker}: ${satteriEntry} -> ${prismEntry}`);
  const { createSatteriMarkdownProcessor } = await import(pathToFileURL(satteriEntry).href);
  const prism = await createSatteriMarkdownProcessor({ syntaxHighlight: "prism" });
  // Each frontend is launched in its own process, before any grammar warmup.
  await Promise.all(
    ["ts", "typescript", "astro"].map(async (lang) => {
      const code = lang === "astro" ? "<p>parallel</p>" : "const parallel: number = 1;";
      const result = await prism.render(fence(lang, code));
      await assertSafeCode(result.code, code, `${worker}/cold concurrent ${lang}`, lang, true);
    }),
  );
  for (const marker of ["```", "~~~"]) {
    for (const fixture of prismCases) {
      const result = await prism.render(fence(fixture.lang, fixture.code, marker));
      await assertSafeCode(
        result.code,
        fixture.code,
        `${worker}/${marker}/${fixture.name}`,
        fixture.decoded ?? (fixture.lang || "plaintext"),
        fixture.tokens,
      );
      console.log(`[frontend-markdown] PASS ${worker}/${marker}/${fixture.name}`);
    }
  }
  await Promise.all(
    ["ts", "typescript", "astro"].map(async (lang) => {
      const code = lang === "astro" ? "<p>parallel</p>" : "const parallel: number = 1;";
      const result = await prism.render(fence(lang, code));
      await assertSafeCode(result.code, code, `${worker}/concurrent ${lang}`, lang, true);
    }),
  );
  const shiki = await createSatteriMarkdownProcessor();
  const shikiCode = 'const escaped: string = "<&>";';
  const rendered = await shiki.render(fence("ts", shikiCode));
  await assertSafeCode(rendered.code, shikiCode, `${worker}/default Shiki`, undefined, true, true);
  console.log(`[frontend-markdown] PASS ${worker}/concurrency and default Shiki`);
}
