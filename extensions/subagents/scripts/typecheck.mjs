/**
 * Typecheck the extension against the globally installed pi.
 *
 * pi resolves extension imports (@earendil-works/*, @sinclair/typebox) to its
 * own bundled copies at runtime. For tsc we mirror that with `paths` resolved
 * from the global npm root, so no heavy pi devDependencies are needed here.
 *
 * Usage: npm run typecheck
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function globalRoot() {
  // execSync with a plain command string: works with npm.cmd on Windows and
  // avoids the shell+args deprecation warning.
  const out = execSync("npm root -g", { encoding: "utf8" });
  return out.trim().replace(/\\/g, "/");
}

function findPiPackage() {
  const roots = [];
  try {
    roots.push(globalRoot());
  } catch (err) {
    console.error(`Warning: 'npm root -g' failed: ${err?.message ?? err}`);
  }
  // Common fallback: global node_modules next to the running node executable.
  roots.push(join(dirname(process.execPath), "node_modules").replace(/\\/g, "/"));

  for (const npmRoot of roots) {
    const candidate = join(npmRoot, "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "dist", "index.d.ts"))) return candidate;
  }
  throw new Error(
    `Could not find @earendil-works/pi-coding-agent under npm roots: ${roots.join(", ")}. Is pi installed globally?`,
  );
}

const pi = findPiPackage();
const piTui = join(pi, "node_modules", "@earendil-works", "pi-tui", "dist", "index.d.ts");
const typebox = join(pi, "node_modules", "typebox", "build", "index.d.mts");

for (const [name, p] of [["pi-tui", piTui], ["typebox", typebox]]) {
  if (!existsSync(p)) throw new Error(`Missing ${name} types at ${p}`);
}

const tsconfig = {
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2023"],
    module: "NodeNext",
    moduleResolution: "nodenext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: false,
    types: ["node"],
    baseUrl: root,
    paths: {
      "@earendil-works/pi-coding-agent": [join(pi, "dist", "index.d.ts")],
      "@earendil-works/pi-tui": [piTui],
      "@sinclair/typebox": [typebox],
    },
  },
  include: ["*.ts", "test/*.ts"],
};

const tsconfigPath = join(root, "tsconfig.generated.json");
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), "utf8");

const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
try {
  execFileSync(process.execPath, [tsc, "-p", tsconfigPath], { stdio: "inherit" });
  console.log("typecheck: OK");
} finally {
  rmSync(tsconfigPath, { force: true });
}
