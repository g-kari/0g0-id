// OpenAPI → Markdown. Pure/offline: invalid specifications fail before rendering.

export type OpenApiSpec = {
  info: { title: string; description?: string };
  paths: Record<string, unknown>;
  components?: Record<string, unknown>;
  security?: Array<Record<string, unknown>>;
};

type ObjectValue = Record<string, unknown>;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const PATH_FIELDS = ["$ref", "summary", "description", "parameters", "servers"];
const TYPES = ["object", "array", "string", "integer", "number", "boolean", "null"];

function object(value: unknown, where: string): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid OpenAPI object: ${where}`);
  }
  return value as ObjectValue;
}

function optionalString(value: unknown, where: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`Invalid OpenAPI string: ${where}`);
  return value;
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid OpenAPI string array: ${where}`);
  }
  return value as string[];
}

function entries(value: ObjectValue): Array<[string, unknown]> {
  return Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function reference(spec: OpenApiSpec, ref: unknown): ObjectValue {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`Only local OpenAPI references are supported: ${String(ref)}`);
  }
  let target: unknown = spec;
  for (const part of ref.slice(2).split("/")) {
    if (/~(?![01])/u.test(part)) throw new Error(`Invalid OpenAPI reference: ${ref}`);
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    const current = object(target, ref);
    if (!Object.hasOwn(current, key)) throw new Error(`Missing OpenAPI reference: ${ref}`);
    target = current[key];
  }
  return object(target, ref);
}

function resolve(spec: OpenApiSpec, value: unknown, where: string): ObjectValue {
  const result = object(value, where);
  if (result.$ref === undefined) return result;
  // Cycles are rejected by validateOpenApiSpec before any render traversal.
  return { ...resolve(spec, reference(spec, result.$ref), where), ...result, $ref: undefined };
}

function validateSchema(spec: OpenApiSpec, value: unknown, where: string): void {
  const schema = resolve(spec, value, where);
  if (schema.type !== undefined) {
    const types = typeof schema.type === "string" ? [schema.type] : strings(schema.type, where);
    if (!types.length || types.some((type) => !TYPES.includes(type))) {
      throw new Error(`Invalid OpenAPI schema type: ${where}`);
    }
  }
  for (const key of ["description", "format", "pattern"])
    optionalString(schema[key], `${where}.${key}`);
  if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") {
    throw new Error(`Invalid OpenAPI nullable: ${where}`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) {
    throw new Error(`Invalid OpenAPI enum: ${where}`);
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
    ) {
      throw new Error(`Invalid OpenAPI constraint: ${where}.${key}`);
    }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    const value = schema[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    ) {
      throw new Error(`Invalid OpenAPI nonnegative integer: ${where}.${key}`);
    }
  }
  for (const [minimum, maximum] of [
    ["minimum", "maximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
  ]) {
    const low = schema[minimum];
    const high = schema[maximum];
    if (typeof low === "number" && typeof high === "number" && low > high) {
      throw new Error(`Invalid OpenAPI range: ${where}.${minimum}/${maximum}`);
    }
  }
  for (const key of ["uniqueItems", "readOnly", "writeOnly"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "boolean") {
      throw new Error(`Invalid OpenAPI boolean constraint: ${where}.${key}`);
    }
  }
  for (const key of ["exclusiveMinimum", "exclusiveMaximum"]) {
    const value = schema[key];
    if (
      value !== undefined &&
      typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(`Invalid OpenAPI exclusive bound: ${where}.${key}`);
    }
  }
  if (schema.required !== undefined) strings(schema.required, `${where}.required`);
  if (schema.properties !== undefined) {
    const properties = object(schema.properties, `${where}.properties`);
    for (const [name, property] of entries(properties))
      validateSchema(spec, property, `${where}.${name}`);
  }
  if (schema.items !== undefined) validateSchema(spec, schema.items, `${where}.items`);
  if (schema.type === "array" && schema.items === undefined) {
    throw new Error(`Missing OpenAPI array items: ${where}`);
  }
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    if (schema[key] !== undefined) {
      const values = schema[key];
      if (!Array.isArray(values) || !values.length)
        throw new Error(`Invalid OpenAPI ${key}: ${where}`);
      values.forEach((item, index) => validateSchema(spec, item, `${where}.${key}[${index}]`));
    }
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    validateSchema(spec, schema.additionalProperties, `${where}.additionalProperties`);
  }
}

function validateContent(spec: OpenApiSpec, value: unknown, where: string): void {
  if (value === undefined) return;
  for (const [media, raw] of entries(object(value, where))) {
    const content = object(raw, `${where}.${media}`);
    if (content.schema !== undefined)
      validateSchema(spec, content.schema, `${where}.${media}.schema`);
  }
}

function parameters(spec: OpenApiSpec, value: unknown, where: string): ObjectValue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid OpenAPI parameters: ${where}`);
  return value.map((raw, index) => {
    const parameter = resolve(spec, raw, `${where}[${index}]`);
    if (
      !optionalString(parameter.name, where) ||
      !["query", "path", "header", "cookie"].includes(String(parameter.in))
    ) {
      throw new Error(`Invalid OpenAPI parameter: ${where}[${index}]`);
    }
    if (parameter.required !== undefined && typeof parameter.required !== "boolean") {
      throw new Error(`Invalid OpenAPI parameter required: ${where}[${index}]`);
    }
    optionalString(parameter.description, where);
    if (parameter.schema !== undefined)
      validateSchema(spec, parameter.schema, `${where}[${index}].schema`);
    validateContent(spec, parameter.content, where);
    return parameter;
  });
}

function security(spec: OpenApiSpec, value: unknown, where: string): ObjectValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Invalid OpenAPI security: ${where}`);
  return value.map((raw) => {
    const requirement = object(raw, where);
    for (const [name, scopes] of entries(requirement)) {
      strings(scopes, `${where}.${name}`);
      const schemes = object(spec.components?.securitySchemes, "components.securitySchemes");
      if (!Object.hasOwn(schemes, name))
        throw new Error(`Missing OpenAPI security scheme: ${name}`);
    }
    return requirement;
  });
}

/** Validate all references, including unused components. Never fetch remote references. */
export function validateOpenApiSpec(spec: OpenApiSpec): void {
  const root = object(spec, "spec");
  const info = object(root.info, "info");
  if (!optionalString(info.title, "info.title")) throw new Error("Missing OpenAPI info.title");
  optionalString(info.description, "info.description");
  // Expand references during validation with an ancestor stack, not a global seen set.
  // Reuse of a component is valid; direct/indirect reference and JS object cycles are not.
  type WalkContext =
    | "document"
    | "schema"
    | "schemaMap"
    | "schemaArray"
    | "exampleMap"
    | "example"
    | "objectMap"
    | "componentMap"
    | "literal";
  const walk = (
    value: unknown,
    ancestors: Set<object>,
    refs: Set<string>,
    context: WalkContext,
  ): void => {
    if (value === null || typeof value !== "object") return;
    if (ancestors.has(value)) throw new Error("Circular OpenAPI object");
    const nextAncestors = new Set(ancestors).add(value);
    if (!Array.isArray(value) && ["document", "schema", "example"].includes(context)) {
      const node = object(value, "reference validation");
      if (node.$ref !== undefined) {
        if (typeof node.$ref !== "string") throw new Error("Invalid OpenAPI $ref");
        if (refs.has(node.$ref)) throw new Error(`Circular OpenAPI reference: ${node.$ref}`);
        walk(reference(spec, node.$ref), nextAncestors, new Set(refs).add(node.$ref), context);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      let childContext: WalkContext = "document";
      if (context === "literal") childContext = "literal";
      else if (context === "schemaMap" || context === "schemaArray") childContext = "schema";
      else if (context === "exampleMap") childContext = "example";
      else if (context === "objectMap") childContext = "document";
      else if (context === "componentMap")
        childContext =
          key === "schemas" ? "schemaMap" : key === "examples" ? "exampleMap" : "objectMap";
      else if (context === "example") childContext = key === "value" ? "literal" : "document";
      else if (context === "schema") {
        if (["default", "example", "examples", "enum", "const"].includes(key))
          childContext = "literal";
        else if (
          ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(
            key,
          )
        )
          childContext = "schemaMap";
        else if (["allOf", "oneOf", "anyOf", "prefixItems"].includes(key))
          childContext = "schemaArray";
        else if (
          [
            "items",
            "additionalProperties",
            "contains",
            "not",
            "if",
            "then",
            "else",
            "propertyNames",
            "unevaluatedProperties",
          ].includes(key)
        )
          childContext = "schema";
      } else if (key === "schema") childContext = "schema";
      else if (key === "components") childContext = "componentMap";
      else if (
        ["paths", "responses", "content", "headers", "callbacks", "links", "pathItems"].includes(
          key,
        )
      )
        childContext = "objectMap";
      else if (key === "example") childContext = "literal";
      else if (key === "examples") childContext = Array.isArray(child) ? "literal" : "exampleMap";
      walk(child, nextAncestors, refs, childContext);
    }
  };
  walk(spec, new Set(), new Set(), "document");
  security(spec, root.security, "security");
  if (spec.components?.schemas !== undefined) {
    for (const [name, schema] of entries(object(spec.components.schemas, "components.schemas"))) {
      validateSchema(spec, schema, `components.schemas.${name}`);
    }
  }
  for (const [path, raw] of entries(object(root.paths, "paths"))) {
    if (!path.startsWith("/")) throw new Error(`Invalid OpenAPI path: ${path}`);
    const item = resolve(spec, raw, path);
    parameters(spec, item.parameters, `${path}.parameters`);
    for (const [method, value] of entries(item)) {
      if (PATH_FIELDS.includes(method)) continue;
      if (method.startsWith("x-")) continue;
      if (!METHODS.includes(method)) throw new Error(`Invalid OpenAPI method: ${path} ${method}`);
      const operation = object(value, `${method} ${path}`);
      optionalString(operation.summary, path);
      optionalString(operation.description, path);
      if (operation.tags !== undefined) strings(operation.tags, `${path}.tags`);
      security(spec, operation.security, path);
      parameters(spec, operation.parameters, `${path}.${method}.parameters`);
      if (operation.requestBody !== undefined) {
        const body = resolve(spec, operation.requestBody, `${path}.requestBody`);
        if (body.required !== undefined && typeof body.required !== "boolean")
          throw new Error(`Invalid OpenAPI requestBody required: ${path}`);
        optionalString(body.description, path);
        validateContent(spec, body.content, `${path}.requestBody.content`);
      }
      const responses = object(operation.responses, `${path}.${method}.responses`);
      if (!Object.keys(responses).length) throw new Error(`Missing OpenAPI responses: ${path}`);
      for (const [status, response] of entries(responses)) {
        if (!/^(?:[1-5][0-9X]{2}|default)$/.test(status))
          throw new Error(`Invalid OpenAPI response status: ${status}`);
        const resolved = resolve(spec, response, `${path}.${status}`);
        optionalString(resolved.description, path);
        validateContent(spec, resolved.content, `${path}.${status}.content`);
      }
    }
  }
}

function cell(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "&#92;")
    .replace(/\|/g, "&#124;")
    .replace(/`/g, "&#96;")
    .replace(/\r?\n/g, "<br>");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${entries(object(value, "JSON"))
      .map(([key, item]) => `${JSON.stringify(key)}: ${stableJson(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value) ?? "";
}

function schemaType(spec: OpenApiSpec, raw: unknown): string {
  const schema = resolve(spec, raw, "schema");
  const types = Array.isArray(schema.type)
    ? (schema.type as string[])
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  const expandedTypes = types.map((type) =>
    type === "array" && schema.items !== undefined
      ? `array<${schemaType(spec, schema.items)}>`
      : type,
  );
  let result =
    expandedTypes.join(" ∪ ") ||
    (schema.properties
      ? "object"
      : schema.items !== undefined
        ? `array<${schemaType(spec, schema.items)}>`
        : "未指定");
  const alternatives = ["allOf", "oneOf", "anyOf"].filter((key) => schema[key] !== undefined);
  if (alternatives.length)
    result = alternatives.join(", ") + (types.includes("null") ? " ∪ null" : "");
  if (schema.nullable === true && !types.includes("null")) result += " ∪ null";
  const ref = object(raw, "schema").$ref;
  if (typeof ref === "string") result += ` (${ref})`;
  return result;
}

function constraints(schema: ObjectValue): string {
  const parts: string[] = [];
  if (schema.enum !== undefined) parts.push(`enum: ${stableJson(schema.enum)}`);
  if (Object.hasOwn(schema, "default")) parts.push(`default: ${stableJson(schema.default)}`);
  for (const key of [
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "pattern",
    "uniqueItems",
    "readOnly",
    "writeOnly",
  ]) {
    if (schema[key] !== undefined)
      parts.push(
        `${key}: ${typeof schema[key] === "string" ? schema[key] : stableJson(schema[key])}`,
      );
  }
  if (typeof schema.additionalProperties === "boolean")
    parts.push(`additionalProperties: ${schema.additionalProperties}`);
  return parts.join("; ");
}

function schemaTable(spec: OpenApiSpec, raw: unknown): string[] {
  const lines = [
    "| フィールド | 必須 | 型 | 制約・既定値 | 説明 |",
    "| --- | --- | --- | --- | --- |",
  ];
  const visit = (value: unknown, name: string, required: boolean): void => {
    const schema = resolve(spec, value, name);
    lines.push(
      `| ${cell(name)} | ${required ? "✓" : ""} | ${cell(schemaType(spec, value))} | ${cell(constraints(schema))} | ${cell(optionalString(schema.description, name))} |`,
    );
    const requiredNames = schema.required === undefined ? [] : strings(schema.required, name);
    if (schema.properties !== undefined) {
      for (const [key, property] of entries(object(schema.properties, name))) {
        visit(property, name === "$" ? key : `${name}.${key}`, requiredNames.includes(key));
      }
    }
    if (schema.items !== undefined) visit(schema.items, `${name}[]`, false);
    for (const key of ["allOf", "oneOf", "anyOf"]) {
      const values = schema[key];
      if (Array.isArray(values))
        values.forEach((item, index) => visit(item, `${name} (${key} ${index + 1})`, false));
    }
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean"
    )
      visit(schema.additionalProperties, `${name}.*`, false);
  };
  visit(raw, "$", false);
  return [...lines, ""];
}

function contentLines(spec: OpenApiSpec, raw: unknown): string[] {
  if (raw === undefined) return [];
  const lines: string[] = [];
  for (const [media, value] of entries(object(raw, "content"))) {
    lines.push(`**Content-Type**: ${cell(media)}`, "");
    const content = object(value, media);
    if (content.schema !== undefined) lines.push(...schemaTable(spec, content.schema));
    else lines.push("スキーマは仕様に記載されていません。", "");
  }
  return lines;
}

/** Deterministic Markdown for runtime docs and checked-in offline API references. */
export function openApiToMarkdown(spec: OpenApiSpec, htmlUrl?: string): string {
  validateOpenApiSpec(spec);
  const lines = [`# ${spec.info.title}`, ""];
  if (htmlUrl) lines.push(`> インタラクティブ版: [${htmlUrl}](${htmlUrl})`, "");
  if (spec.info.description) lines.push(spec.info.description, "");
  lines.push(
    "必須は各オブジェクト内での必須項目です。省略可能な親の子項目は、親がある場合に適用されます。",
    "",
  );
  const schemes = spec.components?.securitySchemes;
  if (schemes !== undefined) {
    lines.push("## 認証方式", "", "| 名前 | 方式 | 説明 |", "| --- | --- | --- |");
    for (const [name, value] of entries(object(schemes, "securitySchemes"))) {
      const scheme = resolve(spec, value, name);
      lines.push(
        `| ${cell(name)} | ${cell([scheme.type, scheme.scheme, scheme.bearerFormat].filter((part) => typeof part === "string").join(" / "))} | ${cell(optionalString(scheme.description, name))} |`,
      );
    }
    lines.push("");
  }
  const groups = new Map<
    string,
    Array<{ path: string; method: string; operation: ObjectValue; item: ObjectValue }>
  >();
  for (const [path, value] of entries(spec.paths)) {
    const item = resolve(spec, value, path);
    for (const method of METHODS) {
      if (item[method] === undefined) continue;
      const operation = object(item[method], path);
      const tags = operation.tags === undefined ? ["その他"] : strings(operation.tags, path);
      // Each endpoint appears once even if multiple tags are attached.
      const tag = tags[0] ?? "その他";
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)!.push({ path, method, operation, item });
    }
  }
  for (const tag of [...groups.keys()].sort()) {
    lines.push(`## ${cell(tag)}`, "");
    for (const { path, method, operation, item } of groups.get(tag)!) {
      lines.push(`### ${method.toUpperCase()} ${cell(path)}`, "");
      if (operation.summary) lines.push(optionalString(operation.summary, path), "");
      if (operation.description) lines.push(optionalString(operation.description, path), "");
      const requirements = security(spec, operation.security ?? spec.security, path);
      const auth =
        requirements === undefined
          ? "仕様に記載なし"
          : !requirements.length
            ? "不要（仕様上）"
            : requirements
                .map((requirement) => {
                  const parts = entries(requirement).map(
                    ([name, scopes]) =>
                      `${name}${(scopes as string[]).length ? ` [${(scopes as string[]).join(", ")}]` : ""}`,
                  );
                  return parts.length ? parts.join(" AND ") : "不要（仕様上）";
                })
                .join(" OR ");
      lines.push(`**認証**: ${cell(auth)}`, "");
      const merged = new Map<string, ObjectValue>();
      for (const parameter of [
        ...parameters(spec, item.parameters, path),
        ...parameters(spec, operation.parameters, path),
      ])
        merged.set(`${String(parameter.in)}:${String(parameter.name)}`, parameter);
      if (merged.size) {
        lines.push(
          "**パラメータ**",
          "",
          "| 名前 | 場所 | 必須 | 型 | 制約・既定値 | 説明 |",
          "| --- | --- | --- | --- | --- | --- |",
        );
        for (const parameter of merged.values()) {
          const schema =
            parameter.schema === undefined ? undefined : resolve(spec, parameter.schema, path);
          lines.push(
            `| ${cell(String(parameter.name))} | ${cell(String(parameter.in))} | ${parameter.required ? "✓" : ""} | ${schema ? cell(schemaType(spec, parameter.schema)) : "未指定"} | ${schema ? cell(constraints(schema)) : ""} | ${cell(optionalString(parameter.description, path))} |`,
          );
        }
        lines.push("");
      }
      if (operation.requestBody !== undefined) {
        const body = resolve(spec, operation.requestBody, path);
        lines.push(`**リクエスト本文**: ${body.required ? "必須" : "省略可"}`, "");
        if (body.description) lines.push(optionalString(body.description, path), "");
        lines.push(...contentLines(spec, body.content));
      }
      lines.push("**レスポンス**", "");
      for (const [status, value] of entries(object(operation.responses, path))) {
        const response = resolve(spec, value, path);
        lines.push(`#### ${cell(status)}`, "", optionalString(response.description, path), "");
        lines.push(...contentLines(spec, response.content));
      }
    }
  }
  if (spec.components?.schemas !== undefined) {
    lines.push("## スキーマ参照", "");
    for (const [name, value] of entries(object(spec.components.schemas, "schemas"))) {
      lines.push(`### ${cell(name)}`, "", ...schemaTable(spec, value));
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
