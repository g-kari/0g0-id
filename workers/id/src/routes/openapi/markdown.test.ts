import { describe, expect, it, vi } from "vite-plus/test";
import { openApiToMarkdown, validateOpenApiSpec, type OpenApiSpec } from "./markdown";
import { INTERNAL_OPENAPI } from "./internal-spec";
import { EXTERNAL_OPENAPI } from "./external-spec";

function fixture(): OpenApiSpec {
  return {
    info: { title: "Synthetic API" },
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: { type: "http", scheme: "bearer", description: "Synthetic bearer" },
        BasicAuth: { type: "http", scheme: "basic" },
      },
      schemas: {
        Payload: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: ["string", "null"],
              enum: ["one|two", "three`four"],
              default: "one|two",
              minLength: 1,
              maxLength: 12,
              description: "line1\nline2 | <script>",
            },
            count: { type: "integer", minimum: 0, maximum: 10, nullable: true },
          },
        },
      },
      parameters: {
        Limit: {
          name: "limit",
          in: "query",
          schema: { type: "integer", default: 20, minimum: 1, maximum: 100 },
        },
      },
      requestBodies: {
        Body: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Payload" } } },
        },
      },
      responses: {
        Result: {
          description: "Synthetic response",
          content: {
            "application/json": {
              schema: { type: "array", items: { $ref: "#/components/schemas/Payload" } },
            },
          },
        },
      },
    },
    paths: {
      "/example": {
        summary: "Path metadata is not an operation",
        parameters: [{ $ref: "#/components/parameters/Limit" }],
        post: {
          tags: ["Example", "Secondary"],
          requestBody: { $ref: "#/components/requestBodies/Body" },
          responses: { "200": { $ref: "#/components/responses/Result" } },
        },
        get: {
          security: [{ BearerAuth: [], BasicAuth: [] }, {}],
          responses: { "204": { description: "No content" } },
        },
        delete: { security: [], responses: { "204": { description: "No content" } } },
      },
    },
  };
}

describe("OpenAPI Markdown", () => {
  it("renders request/response refs, fields, required, enum, nullable/default/ranges and inherited auth", () => {
    const output = openApiToMarkdown(fixture());
    expect(output).toContain("**リクエスト本文**: 必須");
    expect(output).toContain("**Content-Type**: application/json");
    expect(output).toContain("| name | ✓ | string ∪ null |");
    expect(output).toContain('enum: ["one&#124;two", "three&#96;four"]');
    expect(output).toContain('default: "one&#124;two"');
    expect(output).toContain("minimum: 0; maximum: 10");
    expect(output).toContain("line1<br>line2 &#124; &lt;script&gt;");
    expect(output).toContain("$[].name");
    expect(output).toContain("**認証**: BearerAuth");
    expect(output).toContain("BasicAuth AND BearerAuth OR 不要（仕様上）");
    expect(output).toContain("**認証**: 不要（仕様上）");
    expect(output.match(/### POST \/example/g)).toHaveLength(1);
    expect(output).not.toContain("### SUMMARY");
  });

  it("renders allOf/oneOf/anyOf and additionalProperties without losing fields", () => {
    const spec = fixture();
    spec.components!.schemas = {
      Combined: {
        allOf: [
          { type: "object", properties: { first: { type: "string" } } },
          { type: "object", required: ["second"], properties: { second: { type: "boolean" } } },
        ],
      },
      Choice: { oneOf: [{ type: "string" }, { type: "number" }] },
      Anything: { anyOf: [{ type: "null" }, { type: "boolean" }] },
      Payload: { type: "object", additionalProperties: { type: "integer" } },
    };
    const output = openApiToMarkdown(spec);
    expect(output).toContain("$ (allOf 2).second | ✓ | boolean");
    expect(output).toContain("$ (oneOf 2)");
    expect(output).toContain("$ (anyOf 1)");
    expect(output).toContain("$.*");
  });

  it("is byte-identical despite object insertion order and never fetches", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Network forbidden");
    });
    try {
      const spec = fixture();
      const reverse = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(reverse);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, child]) => [key, reverse(child)]),
          );
        return value;
      };
      expect(openApiToMarkdown(reverse(spec) as OpenApiSpec)).toBe(openApiToMarkdown(spec));
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("preserves nullable and other union members on array schemas", () => {
    const spec = fixture();
    spec.components!.schemas = {
      Payload: { type: ["array", "null", "string"], items: { type: "string" } },
    };
    expect(openApiToMarkdown(spec)).toContain("array&lt;string&gt; ∪ null ∪ string");
  });

  it("treats $ref in default/example/enum JSON values as literal data", () => {
    const spec = fixture();
    spec.components!.schemas = {
      Payload: {
        type: "object",
        default: { $ref: "hello" },
        examples: [{ $ref: "world" }],
        enum: [{ $ref: "literal" }],
      },
    };
    expect(openApiToMarkdown(spec)).toContain('default: {"$ref": "hello"}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    spec.components!.schemas = { Payload: { type: "object", default: cyclic } };
    expect(() => openApiToMarkdown(spec)).toThrow(/Circular/);
  });

  it("still validates real default response and named example references", () => {
    const spec = fixture();
    spec.paths = {
      "/x": { get: { responses: { default: { $ref: "#/components/responses/Missing" } } } },
    };
    expect(() => openApiToMarkdown(spec)).toThrow(/Missing/);
    spec.paths = {
      "/x": {
        get: {
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  examples: { named: { $ref: "#/components/examples/Missing" } },
                },
              },
            },
          },
        },
      },
    };
    expect(() => openApiToMarkdown(spec)).toThrow(/Missing/);
  });

  it.each(["responses", "parameters", "requestBodies", "headers", "pathItems"])(
    "validates arbitrary %s component names as real references",
    (section) => {
      for (const name of ["value", "example", "default"]) {
        const spec = fixture();
        spec.components![section] = { [name]: { $ref: `#/components/${section}/Missing` } };
        expect(() => openApiToMarkdown(spec)).toThrow(/Missing/);
      }
    },
  );

  it("treats only Example Object values as literal while validating named example refs", () => {
    const spec = fixture();
    spec.components!.examples = {
      example: { value: { $ref: "literal" } },
      value: { value: { $ref: "literal" } },
    };
    expect(() => openApiToMarkdown(spec)).not.toThrow();
    spec.components!.examples = { value: { $ref: "#/components/examples/Missing" } };
    expect(() => openApiToMarkdown(spec)).toThrow(/Missing/);
  });

  it("allows map entries literally named $ref without treating containers as references", () => {
    const spec = fixture();
    spec.components!.schemas = {
      Payload: { type: "object", properties: { $ref: { type: "string" } } },
    };
    expect(openApiToMarkdown(spec)).toContain("| $ref |  | string |");
    spec.components!.examples = { $ref: { value: { $ref: "literal" } } };
    expect(() => openApiToMarkdown(spec)).not.toThrow();
  });

  it("keeps internal and external paths and schema components isolated", () => {
    const internal = openApiToMarkdown(INTERNAL_OPENAPI);
    const external = openApiToMarkdown(EXTERNAL_OPENAPI);
    expect(internal).toContain("### GET /api/admin/audit-logs");
    expect(external).not.toContain("/api/admin/audit-logs");
    expect(external).not.toContain("### AdminAuditLog");
    expect(external).toContain("### ExternalUser");
    expect(internal).not.toContain("### ExternalUser");
    expect(external).toContain("### OAuthError");
  });

  it.each([
    ["missing", { $ref: "#/components/schemas/Missing" }],
    ["external", { $ref: "https://example.invalid/schema.json" }],
    ["invalid type", { type: "oops" }],
    ["invalid properties", { type: "object", properties: [] }],
    ["invalid required", { type: "object", required: "name" }],
    ["invalid enum", { type: "string", enum: [] }],
    ["missing array items", { type: "array" }],
    ["negative length", { type: "string", minLength: -1 }],
    ["fractional items", { type: "array", items: { type: "string" }, maxItems: 1.5 }],
    ["reversed range", { type: "number", minimum: 10, maximum: 1 }],
    ["invalid boolean", { type: "string", readOnly: "hello" }],
    ["invalid exclusive bound", { type: "number", exclusiveMinimum: "oops" }],
    ["invalid composition", { allOf: [] }],
  ])("fails explicitly for %s schemas, including unused components", (_label, schema) => {
    const spec = fixture();
    spec.components!.schemas = { Payload: schema };
    expect(() => openApiToMarkdown(spec)).toThrow();
  });

  it("rejects direct/indirect ref cycles and actual JS object cycles", () => {
    const spec = fixture();
    spec.components!.schemas = {
      Payload: { $ref: "#/components/schemas/Other" },
      Other: { $ref: "#/components/schemas/Payload" },
    };
    expect(() => openApiToMarkdown(spec)).toThrow(/Circular/);
    spec.components!.schemas = {
      Payload: { type: "object", properties: { child: { $ref: "#/components/schemas/Payload" } } },
    };
    expect(() => openApiToMarkdown(spec)).toThrow(/Circular/);
    const self: Record<string, unknown> = {};
    self.self = self;
    spec.components!.schemas = { Payload: self };
    expect(() => openApiToMarkdown(spec)).toThrow(/Circular/);
  });

  it("rejects malformed operation/parameter/response/auth structures", () => {
    for (const path of [
      { get: { responses: [] } },
      { get: { parameters: [{ name: "x", in: "wrong" }], responses: { "200": {} } } },
      { get: { responses: { wrong: {} } } },
      { get: { security: [{ Unknown: [] }], responses: { "200": {} } } },
      { connect: { responses: { "200": {} } } },
    ]) {
      expect(() =>
        validateOpenApiSpec({ info: { title: "Synthetic" }, paths: { "/x": path } }),
      ).toThrow();
    }
  });

  it("supports JSON pointer escaping and local path refs", () => {
    const spec: OpenApiSpec = {
      info: { title: "Synthetic" },
      components: {
        schemas: { "A/B~C": { type: "string" } },
        pathItems: {
          Example: {
            get: {
              responses: {
                "200": {
                  description: "OK",
                  content: { "text/plain": { schema: { $ref: "#/components/schemas/A~1B~0C" } } },
                },
              },
            },
          },
        },
      },
      paths: { "/x": { $ref: "#/components/pathItems/Example" } },
    };
    expect(openApiToMarkdown(spec)).toContain("### GET /x");
  });
});
