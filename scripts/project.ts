#!/usr/bin/env node
/**
 * 项目命令：创建 / 删除 workspace 包。
 *
 *   pnpm project new pkg <name>    创建 packages/<name>
 *   pnpm project new app <name>    创建 apps/<name>
 *   pnpm project del <name>        删除 packages/ 或 apps/ 下的 <name>
 *   pnpm project list              列出当前工作区
 *
 * 零依赖，靠 Node 24 原生类型剥离直接跑。
 *
 * ⚠ 不要把 package.json 里的脚本改名为 ci / rm / remove / create / add / pkg ——
 * 那些是 pnpm 的内建命令，会把同名脚本静默吃掉（详见 DEVDOCS 坑 5）。
 * 只暴露 `project` 这一个入口就是为了躲开这类碰撞。
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIRS = ["packages", "apps"] as const;
type Dir = (typeof DIRS)[number];

/** 目录名即包名（不含 scope）。同时用于校验，避免造出装不上的包名。 */
const NAME_RE = /^[a-z][a-z0-9-]*$/;

interface Ref {
  dir: Dir;
  pkg: string;
  dep: string;
}

function die(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** scope 从根 package.json 的 name 推出来，所以模板被改名重用时行为仍然正确。 */
async function scopeOf(): Promise<string> {
  const { name } = await readJson<{ name?: unknown }>(path.join(ROOT, "package.json"));
  if (typeof name !== "string" || name === "") die("根 package.json 缺少 name，无法推出 scope");
  return `@${name}`;
}

/** 在所有 workspace 目录里找同名包，返回它所在的那一层。 */
async function locate(name: string): Promise<Dir | undefined> {
  for (const dir of DIRS) {
    if (await exists(path.join(ROOT, dir, name))) return dir;
  }
  return undefined;
}

async function entriesOf(dir: Dir): Promise<string[]> {
  const base = path.join(ROOT, dir);
  if (!(await exists(base))) return [];
  const entries = await readdir(base, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function checkName(name: string | undefined): asserts name is string {
  if (name === undefined) die("要给定包名");
  if (!NAME_RE.test(name)) {
    die(`包名不合法：${name}\n    只允许小写字母、数字、连字符，且以字母开头（例如 chat-core）`);
  }
}

async function newTarget(kind: "pkg" | "app", name: string): Promise<void> {
  const dir: Dir = kind === "pkg" ? "packages" : "apps";
  const fullName = `${await scopeOf()}/${name}`;
  const target = path.join(ROOT, dir, name);

  if (await exists(target)) die(`${dir}/${name} 已存在`);

  // pkg 与 app 的区别只在 exports/private 和入口文件名：
  // 包是给别人 import 的（exports 指源码），app 是跑起来的（不需要 exports）。
  const manifest =
    kind === "pkg"
      ? { name: fullName, version: "0.0.0", type: "module", exports: { ".": "./src/index.ts" } }
      : { name: fullName, version: "0.0.0", private: true, type: "module" };

  const entry = kind === "pkg" ? "src/index.ts" : "src/main.ts";
  const body =
    kind === "pkg"
      ? `// ${fullName}\nexport {};\n`
      : `// ${fullName}\n// 跑：node ${dir}/${name}/${entry}\n\nexport {};\n`;

  await mkdir(path.join(target, "src"), { recursive: true });
  await writeJson(path.join(target, "package.json"), manifest);
  await writeFile(path.join(target, entry), body);

  console.log(`\n  已创建 ${dir}/${name}\n`);
  console.log(`    ${dir}/${name}/package.json   ${fullName}`);
  console.log(`    ${dir}/${name}/${entry}`);
  console.log(`\n  下一步：pnpm install       （让 workspace 认领它，否则 ${fullName} 解析不到）`);
  console.log(`          pnpm verify        （确认类型检查 / lint / 测试都过）\n`);
}

/**
 * 找出所有用 `workspace:*` 依赖着 <name> 的 workspace 包。
 *
 * 这个检查不是"顺手提示"，是硬需求：pnpm 解析不到 workspace 依赖时，
 * **整个仓库的脚本都会拒绝运行**（连它自己的 pre-run 依赖检查都过不去），
 * 所以留下悬空引用等于把仓库锁死。
 */
async function referencedBy(name: string): Promise<Ref[]> {
  const refs: Ref[] = [];
  for (const dir of DIRS) {
    for (const pkg of await entriesOf(dir)) {
      if (pkg === name) continue;
      const file = path.join(ROOT, dir, pkg, "package.json");
      if (!(await exists(file))) continue;
      const manifest = await readJson<{
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }>(file);
      for (const group of [manifest.dependencies, manifest.devDependencies]) {
        for (const [dep, spec] of Object.entries(group ?? {})) {
          if (dep.endsWith(`/${name}`) && spec.startsWith("workspace:")) {
            refs.push({ dir, pkg, dep });
          }
        }
      }
    }
  }
  return refs;
}

/** 把引用方 package.json 里指向 <name> 的依赖行删掉，避免仓库被锁死。 */
async function stripReferences(name: string, refs: readonly Ref[]): Promise<void> {
  const touched = new Set<string>();
  for (const ref of refs) {
    const file = path.join(ROOT, ref.dir, ref.pkg, "package.json");
    if (touched.has(file)) continue;
    touched.add(file);

    const manifest = await readJson<Record<string, unknown>>(file);
    for (const key of ["dependencies", "devDependencies"]) {
      const group = manifest[key];
      if (group === undefined || typeof group !== "object") continue;
      const record = group as Record<string, string>;
      for (const dep of Object.keys(record)) {
        if (dep.endsWith(`/${name}`)) delete record[dep];
      }
      if (Object.keys(record).length === 0) delete manifest[key];
    }
    await writeJson(file, manifest);
    console.log(`    已清除引用：${ref.dir}/${ref.pkg}/package.json`);
  }
}

async function delTarget(name: string, force: boolean): Promise<void> {
  const dir = await locate(name);
  if (dir === undefined) die(`找不到 packages/${name} 或 apps/${name}`);

  const target = path.join(ROOT, dir, name);
  const files: string[] = [];
  async function walk(p: string): Promise<void> {
    for (const entry of await readdir(p, { withFileTypes: true })) {
      const child = path.join(p, entry.name);
      if (entry.isDirectory()) await walk(child);
      else files.push(path.relative(ROOT, child));
    }
  }
  await walk(target);

  const refs = await referencedBy(name);

  if (refs.length > 0 && !force) {
    console.error(`\n  ✗ 还有包依赖着 ${dir}/${name}，不能直接删：\n`);
    for (const ref of refs) console.error(`      ${ref.dir}/${ref.pkg}  →  ${ref.dep}`);
    console.error(`\n    原因：pnpm 解析不到 workspace 依赖时，整个仓库的脚本都会拒绝运行 ——`);
    console.error(`    删完不清理引用，你连 pnpm 命令都跑不了，包括这条命令自己。\n`);
    console.error(`    两条出路：`);
    console.error(`      1. 先手工去掉上面这些依赖行，再删`);
    console.error(`      2. pnpm project del ${name} --force    （删的同时自动清掉那些依赖行）\n`);
    process.exit(1);
  }

  console.log(`\n  将删除 ${dir}/${name}，共 ${files.length} 个文件：\n`);
  for (const f of files) console.log(`    ${f}`);

  if (refs.length > 0) {
    console.log(`\n  同时会清掉这些引用：`);
    for (const ref of refs) console.log(`    ${ref.dir}/${ref.pkg}  →  ${ref.dep}`);
  }

  if (!process.argv.includes("--yes") && !(await confirm("\n  确认删除？(y/N) "))) {
    console.log("\n  已取消\n");
    return;
  }

  await rm(target, { recursive: true });
  if (refs.length > 0) await stripReferences(name, refs);

  console.log(`\n  已删除 ${dir}/${name}`);
  console.log(`\n  下一步：pnpm install       （清掉锁文件里的残留）\n`);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log("\n  （非交互环境，未确认。要确认请加 --yes）");
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

async function list(): Promise<void> {
  const scope = await scopeOf();
  let total = 0;
  for (const dir of DIRS) {
    const entries = await entriesOf(dir);
    console.log(`\n  ${dir}/`);
    if (entries.length === 0) console.log("    （空）");
    for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
      const file = path.join(ROOT, dir, entry, "package.json");
      const name = (await exists(file))
        ? (await readJson<{ name?: string }>(file)).name
        : undefined;
      const flag = name === `${scope}/${entry}` ? "" : "  ⚠ 名字和目录对不上";
      console.log(`    ${entry.padEnd(20)} ${name ?? "(缺 package.json)"}${flag}`);
      total += 1;
    }
  }
  console.log(`\n  共 ${total} 个\n`);
}

function usage(): void {
  console.log(`
  项目命令

    pnpm project new pkg <name>    创建 packages/<name>
    pnpm project new app <name>    创建 apps/<name>
    pnpm project del <name>        删除（有包依赖它时会拒绝；--force 连带清理引用）
    pnpm project list              列出当前工作区

  包名规则：小写字母 / 数字 / 连字符，字母开头。目录名即包名，scope 取自根 package.json。
`);
}

const [sub, ...rest] = process.argv.slice(2);

switch (sub) {
  case "new": {
    const [kind, name] = rest;
    if (kind !== "pkg" && kind !== "app") die("用法：pnpm project new <pkg|app> <name>");
    checkName(name);
    await newTarget(kind, name);
    break;
  }
  case "del": {
    const [name] = rest;
    checkName(name);
    await delTarget(name, rest.includes("--force"));
    break;
  }
  case "list":
    await list();
    break;
  case undefined:
  case "-h":
  case "--help":
  case "help":
    usage();
    break;
  default:
    die(`未知子命令：${sub}（跑 pnpm project --help 看用法）`);
}
