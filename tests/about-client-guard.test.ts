// #350：src/lib/seo/about.ts 只给服务端用（这一轮不加 server-only 依赖，PM 定）。
// 这条测试守住它：任何首条语句是 'use client' 的文件，都不许 import about.ts。
// - 必须项：直接 import（相对路径或 @/ 别名）。
// - 附加项：沿相对路径 / @/ 别名的静态 import、re-export、import()、require() 往下追（含 index 文件），带 visited 集合，
//   能追到 about.ts 也算失败。裸包名（react、next/...）不追。只有类型的 import/export（import type）会被编译器擦掉，不算。
// 用 TypeScript 自己的语法树取 import，不用正则，注释和字符串里的路径不会被误认。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TARGET = path.join(SRC, 'lib', 'seo', 'about.ts');
const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

type Host = { isFile(p: string): boolean; read(p: string): string };
const fsHost: Host = {
  isFile: (p) => existsSync(p) && statSync(p).isFile(),
  read: (p) => readFileSync(p, 'utf8'),
};

function aliasRoot(): { prefix: string; dir: string } {
  // tsconfig 里 "@/*": ["./src/*"]；读出来核对，别名改了这条测试会先报错。
  const cfg = ts.parseConfigFileTextToJson('tsconfig.json', readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')).config;
  const target = cfg?.compilerOptions?.paths?.['@/*'];
  assert.deepEqual(target, ['./src/*'], 'tsconfig paths 的 @/* 变了，请同步更新这条测试');
  return { prefix: '@/', dir: SRC };
}

function parse(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX
    : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

export function isClientFile(file: string, text: string): boolean {
  const first = parse(file, text).statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use client';
}

/** 运行时会真正加载的模块路径（去掉只有类型的 import/export）。 */
export function moduleSpecifiers(file: string, text: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      if (!node.isTypeOnly) out.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const isDynImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynImport || isRequire) out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, text));
  return out;
}

/** 解析本地模块路径；裸包名返回 'external'；本地但找不到返回 null。 */
export function resolveLocal(fromFile: string, spec: string, host: Host, alias: { prefix: string; dir: string }): string | 'external' | null {
  let base: string;
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith(alias.prefix)) base = path.join(alias.dir, spec.slice(alias.prefix.length));
  else return 'external';
  const candidates = [base, ...CODE_EXT.map((e) => base + e), ...CODE_EXT.map((e) => path.join(base, 'index' + e))];
  if (/\.(m?js|jsx)$/.test(base)) { const stem = base.replace(/\.(m?js|jsx)$/, ''); candidates.push(stem + '.ts', stem + '.tsx'); }
  return candidates.find((c) => host.isFile(c)) ?? null;
}

type Finding = { client: string; chain: string[] };

/** 从每个 client 文件出发找 target。direct=true 只看第一层。unresolved 收集找不到的本地路径。 */
export function findClientImports(clients: string[], target: string, host: Host, alias: { prefix: string; dir: string }, opts: { direct: boolean }) {
  const findings: Finding[] = [];
  const unresolved: string[] = [];
  for (const client of clients) {
    const visited = new Set<string>([client]);
    const stack: string[][] = [[client]];
    let hit: string[] | null = null;
    while (stack.length && !hit) {
      const chain = stack.pop()!;
      const file = chain[chain.length - 1];
      if (!CODE_EXT.some((e) => file.endsWith(e))) continue; // css/json/图片等是叶子
      for (const spec of moduleSpecifiers(file, host.read(file))) {
        const r = resolveLocal(file, spec, host, alias);
        if (r === 'external') continue;
        if (r === null) { unresolved.push(`${file} -> ${spec}`); continue; }
        if (r === target) { hit = [...chain, r]; break; }
        if (opts.direct || visited.has(r)) continue;
        visited.add(r);
        stack.push([...chain, r]);
      }
    }
    if (hit) findings.push({ client, chain: hit });
  }
  return { findings, unresolved };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : CODE_EXT.some((e) => p.endsWith(e)) ? [p] : [];
  });
}

const rel = (p: string) => path.relative(ROOT, p);

// ---------- 解析器自测（内存文件表，不碰磁盘） ----------
function memHost(files: Record<string, string>): Host {
  return { isFile: (p) => p in files, read: (p) => files[p] };
}
const R = '/fx';
const A = { prefix: '@/', dir: `${R}/src` };
const T = `${R}/src/lib/seo/about.ts`;
const base: Record<string, string> = { [T]: 'export const x = 1;\n', [`${R}/src/lib/seo/other.ts`]: 'export const y = 2;\n' };
const run = (files: Record<string, string>, direct: boolean) => {
  const all = { ...base, ...files };
  const host = memHost(all);
  const clients = Object.keys(all).filter((f) => isClientFile(f, all[f]));
  return findClientImports(clients, T, host, A, { direct });
};

test('client guard 自测：直接相对路径 import 会被抓到', () => {
  const r = run({ [`${R}/src/components/A.tsx`]: "'use client';\nimport { x } from '../lib/seo/about';\n" }, true);
  assert.equal(r.findings.length, 1);
});

test('client guard 自测：@/ 别名、带扩展名、双引号指令都会被抓到', () => {
  const r = run({
    [`${R}/src/components/A.tsx`]: '"use client"\nimport { x } from "@/lib/seo/about";\n',
    [`${R}/src/components/B.tsx`]: "'use client';\nexport { x } from '@/lib/seo/about.ts';\n",
  }, true);
  assert.equal(r.findings.length, 2);
});

test('client guard 自测：两跳间接（经 index 再导出 + import()）会被附加检查抓到，直接检查不报', () => {
  const files = {
    [`${R}/src/components/C.tsx`]: "'use client';\nimport { z } from '../lib/hub';\n",
    [`${R}/src/lib/hub/index.ts`]: "export const z = () => import('@/lib/seo/mid');\n",
    [`${R}/src/lib/seo/mid.ts`]: "export * from './about';\n",
  };
  const ind = run(files, false);
  assert.equal(ind.findings.length, 1);
  assert.deepEqual(ind.findings[0].chain.map((p) => path.relative(R, p)),
    ['src/components/C.tsx', 'src/lib/hub/index.ts', 'src/lib/seo/mid.ts', 'src/lib/seo/about.ts']);
  assert.equal(run(files, true).findings.length, 0);
});

test('client guard 自测：环形 import 不死循环；require 也算', () => {
  const r = run({
    [`${R}/src/components/D.tsx`]: "'use client';\nimport './a';\n",
    [`${R}/src/components/a.ts`]: "import './b';\n",
    [`${R}/src/components/b.ts`]: "import './a';\nconst m = require('../lib/seo/about');\n",
  }, false);
  assert.equal(r.findings.length, 1);
});

test('client guard 自测：不误报——服务端文件、只有类型的 import、注释/字符串里的路径、非首条语句的指令', () => {
  const r = run({
    [`${R}/src/app/page.tsx`]: "import { x } from '@/lib/seo/about';\n",
    [`${R}/src/components/E.tsx`]: "'use client';\nimport type { X } from '@/lib/seo/about';\nexport type { Y } from '../lib/seo/about';\n",
    [`${R}/src/components/F.tsx`]: "'use client';\n// import '@/lib/seo/about'\nconst s = \"import('@/lib/seo/about')\";\nimport { y } from '@/lib/seo/other';\n",
    [`${R}/src/components/G.tsx`]: "import { x } from '@/lib/seo/about';\n'use client';\n",
    [`${R}/src/components/H.tsx`]: "'use client';\nimport React from 'react';\nimport '@/styles/x.css';\n",
  }, false);
  assert.equal(r.findings.length, 0);
});

// ---------- 真仓库 ----------
test('真仓库：没有任何 "use client" 文件直接 import src/lib/seo/about.ts（必须项）', () => {
  const alias = aliasRoot();
  assert.ok(fsHost.isFile(TARGET), 'src/lib/seo/about.ts 不存在了？请同步这条测试');
  const files = walk(SRC);
  const clients = files.filter((f) => isClientFile(f, fsHost.read(f)));
  assert.ok(clients.length > 0, '一个 use client 文件都没扫到，扫描逻辑可能坏了');
  const { findings } = findClientImports(clients, TARGET, fsHost, alias, { direct: true });
  assert.deepEqual(findings.map((f) => f.chain.map(rel).join(' -> ')), [],
    'about.ts 只给服务端用：客户端组件请改为由服务端组件算好数据再传 props');
});

test('真仓库：间接引入（多跳）也没有，而且所有本地路径都解析得到（附加项）', () => {
  const alias = aliasRoot();
  const files = walk(SRC);
  const clients = files.filter((f) => isClientFile(f, fsHost.read(f)));
  const { findings, unresolved } = findClientImports(clients, TARGET, fsHost, alias, { direct: false });
  assert.deepEqual(unresolved, [], '有本地 import 解析不到，间接检查不可信，请补解析规则');
  assert.deepEqual(findings.map((f) => f.chain.map(rel).join(' -> ')), [],
    'about.ts 只给服务端用：客户端组件请改为由服务端组件算好数据再传 props');
});
