import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The parse-only function exists to keep parsers out of the upload routes' process, and the
// database, session and model clients out of the parser's. Both depend on what each route
// imports, so this walks their static import graphs. (`bun run check:ocr-trace` checks the built
// traces for the OCR runtime as well.)

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(appDir, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(from), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
    if (/\.(?:ts|tsx|js)$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every app module and package a module reaches through value imports (type imports erase). */
function importGraph(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const pending = [path.join(appDir, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (modules.has(file)) continue;
    modules.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']/gms),
      ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
      ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]!);
    for (const specifier of specifiers) {
      const local = resolveLocal(file, specifier);
      if (local) pending.push(local);
      else if (!specifier.startsWith("node:")) packages.add(specifier);
    }
  }
  return {
    modules: new Set([...modules].map((file) => path.relative(appDir, file))),
    packages,
  };
}

describe("parser isolation", () => {
  it.each([
    "app/api/contracts/[id]/upload/route.ts",
    "app/api/projects/[id]/context/route.ts",
    "app/api/chat/files/route.ts",
  ])(
    "%s does not import the parsers",
    (route) => {
      const { modules, packages } = importGraph(route);
      expect(modules).toContain("lib/parse-client.ts");
      expect(modules).not.toContain("lib/text-extraction.ts");
      expect(modules).not.toContain("lib/document-parser.ts");
      expect(modules).not.toContain("lib/extraction-limits.ts");
      for (const parser of ["unpdf", "word-extractor", "tesseract.js"]) {
        expect(packages).not.toContain(parser);
      }
    },
  );

  it("the parse route imports the parsers and storage, but no database, session or model client", () => {
    const { modules, packages } = importGraph("app/api/internal/parse/route.ts");
    expect(modules).toContain("lib/text-extraction.ts");
    expect(modules).toContain("lib/object-storage.ts");
    for (const appModule of [
      "lib/server-db.ts",
      "lib/auth.ts",
      "lib/api-auth.ts",
      "lib/llm-client.ts",
      "lib/chat.ts",
      "lib/upload-pipeline.ts",
    ]) {
      expect(modules).not.toContain(appModule);
    }
    for (const pkg of ["@vercel/postgres", "@neondatabase/serverless", "@workos-inc/authkit-nextjs", "@workos-inc/node", "openai", "ai", "@repo/chat-engine"]) {
      expect(packages).not.toContain(pkg);
    }
  });
});
