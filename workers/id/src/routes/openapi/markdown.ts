// OpenAPI → Markdown 変換

type OpenApiOperation = {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: { type?: string; enum?: string[] };
  }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string }>;
  security?: Array<Record<string, unknown>>;
};

export type OpenApiSpec = {
  info: { title: string; description?: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
};

/**
 * OpenAPI 仕様オブジェクトをAI/人間が読みやすいMarkdownに変換する。
 * JSなしで参照可能な /docs/external.md / /docs/openapi.md エンドポイント向け。
 */
export function openApiToMarkdown(spec: OpenApiSpec, htmlUrl?: string): string {
  const lines: string[] = [];
  lines.push(`# ${spec.info.title}`);
  lines.push("");
  if (htmlUrl) {
    lines.push(`> インタラクティブ版（Swagger UI）: [${htmlUrl}](${htmlUrl})`);
    lines.push("");
  }
  if (spec.info.description) {
    lines.push(spec.info.description);
    lines.push("");
  }

  // pathsをtagでグループ化
  const byTag: Record<string, Array<{ path: string; method: string; op: OpenApiOperation }>> = {};
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tags = op.tags ?? ["その他"];
      for (const tag of tags) {
        if (!byTag[tag]) byTag[tag] = [];
        byTag[tag].push({ path, method, op });
      }
    }
  }

  for (const [tag, ops] of Object.entries(byTag)) {
    lines.push(`## ${tag}`);
    lines.push("");
    for (const { path, method, op } of ops) {
      lines.push(`### ${method.toUpperCase()} ${path}`);
      lines.push("");
      if (op.summary) {
        lines.push(`**${op.summary}**`);
        lines.push("");
      }
      if (op.description) {
        lines.push(op.description);
        lines.push("");
      }
      if (op.security) {
        const schemes = op.security.flatMap((s) => Object.keys(s));
        if (schemes.length > 0) {
          lines.push(`**認証**: ${schemes.join(", ")}`);
          lines.push("");
        }
      }
      if (op.parameters && op.parameters.length > 0) {
        lines.push("**パラメータ**");
        lines.push("");
        lines.push("| 名前 | 場所 | 必須 | 型 | 説明 |");
        lines.push("|------|------|------|----|------|");
        for (const p of op.parameters) {
          const required = p.required ? "✓" : "";
          const type = p.schema?.enum
            ? p.schema.enum.map((v) => `\`${v}\``).join(" | ")
            : (p.schema?.type ?? "");
          const desc = (p.description ?? "").replace(/\n/g, " ");
          lines.push(`| \`${p.name}\` | ${p.in} | ${required} | ${type} | ${desc} |`);
        }
        lines.push("");
      }
      if (op.responses) {
        lines.push("**レスポンス**");
        lines.push("");
        for (const [status, resp] of Object.entries(op.responses)) {
          lines.push(`- **${status}**: ${resp.description ?? ""}`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}
