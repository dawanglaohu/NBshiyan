/**
 * 生产镜像的构建上下文等于仓库减去 .dockerignore。
 * Next 构建会解析 src/、根配置和 scripts/ 里的 import、require、new URL。
 * 这些说明符若落到被排除的路径（例如 docs/），docker build 在 COPY 之后找不到文件。
 * src/ 里被排除的源码同样进不了镜像，Next 路由会变成 404。
 * CI 的 pnpm build 用的是完整检出，发现不了这件事。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SCAN = /\.(?:[cm]?[jt]sx?|css)$/;
const SKIP_SPEC = /^(?:node:|data:|https?:|blob:)/;
const SKIP_WALK = new Set(['node_modules', '.next', '.git']);

export type IgnoreRule = {
  negate: boolean;
  directoryOnly: boolean;
  /** 不带 / 的模式按文件名匹配任意一层。开头的 / 只匹配仓库根。 */
  basename: boolean;
  regex: RegExp;
};

export type ContextViolation = {
  file: string;
  specifier: string;
  resolved: string;
  reason: string;
};

export function parseDockerignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1).trim();
      if (!line) continue;
    }
    // Docker 会去掉模式开头的 /，/uploads 与 uploads 在镜像里都只排除仓库根那一层。
    // 这里不带 / 的模式仍按文件名匹配任意一层（*.log）。开头的 / 收成仓库根，
    // 这样 /uploads 不会带走 src/app/api/uploads。
    let rooted = false;
    if (line.startsWith('/')) {
      rooted = true;
      line = line.replace(/^\/+/, '');
      if (!line) continue;
    }
    const directoryOnly = line.endsWith('/');
    if (directoryOnly) line = line.replace(/\/+$/, '');
    if (!line) continue;
    rules.push({
      negate,
      directoryOnly,
      basename: !rooted && !line.includes('/'),
      regex: globToRegExp(line),
    });
  }
  return rules;
}

function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (pattern.startsWith('**', i)) {
      out += '.*';
      i += 1;
      continue;
    }
    const char = pattern[i];
    if (char === '*') {
      out += '[^/]*';
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    out += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

function cleanRel(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** 最后一条命中的规则生效。文件本身没有命中时，被排除的父目录带走子路径。 */
export function isDockerignored(relPath: string, rules: IgnoreRule[]): boolean {
  const rel = cleanRel(relPath);
  const self = lastMatch(rel, rules, false);
  if (self !== null) return self;
  const parts = rel.split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    if (lastMatch(parts.slice(0, i).join('/'), rules, true) === true) return true;
  }
  return false;
}

function lastMatch(rel: string, rules: IgnoreRule[], asDirectory: boolean): boolean | null {
  let matched: boolean | null = null;
  for (const rule of rules) {
    if (rule.directoryOnly && !asDirectory) continue;
    const target = rule.basename ? rel.split('/').pop() ?? rel : rel;
    if (rule.regex.test(target)) matched = !rule.negate;
  }
  return matched;
}

function blankComments(source: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'squote' | 'dquote' | 'template' = 'code';
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (char === "'") state = 'squote';
      else if (char === '"') state = 'dquote';
      else if (char === '`') state = 'template';
      out += char;
      i++;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += char;
      } else out += ' ';
      i++;
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += char === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (char === '\\') {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    const end = state === 'squote' ? "'" : state === 'dquote' ? '"' : '`';
    out += char;
    i++;
    if (char === end) state = 'code';
  }
  return out;
}

/** 模板字符串里 ${} 之前的目录。完整静态模板原样返回。 */
function staticTemplateSpecifier(value: string): string | null {
  if (!value.includes('${')) return value;
  const head = value.slice(0, value.indexOf('${'));
  const slash = head.lastIndexOf('/');
  if (slash <= 0) return null;
  const prefix = head.slice(0, slash);
  if (!prefix || prefix === '.' || prefix === '..') return null;
  return prefix;
}

function pushSpecifier(found: string[], seen: Set<string>, raw: string, quote: string): void {
  let value = raw.trim();
  if (!value) return;
  if (quote === '`') {
    const resolved = staticTemplateSpecifier(value);
    if (!resolved) return;
    value = resolved;
  }
  if (seen.has(value)) return;
  seen.add(value);
  found.push(value);
}

export function moduleSpecifiers(source: string): string[] {
  const text = blankComments(source);
  const found: string[] = [];
  const seen = new Set<string>();
  const quoted: Array<{ pattern: RegExp; spec: number; quote: number }> = [
    // from 两侧的空白可缺：export{a}from'./a'、import x from"./a"
    { pattern: /(?:^|[\n;])\s*(?:import|export)\s*(?:type\s+)?(?:[^'";]*?\s*from\s*)?(['"`])([^'"`]+)\1/g, spec: 2, quote: 1 },
    { pattern: /\bimport\s*\(\s*(['"`])([^'"`]+)\1/g, spec: 2, quote: 1 },
    { pattern: /\brequire\s*\(\s*(['"`])([^'"`]+)\1/g, spec: 2, quote: 1 },
    { pattern: /\bnew\s+URL\s*\(\s*(['"`])([^'"`]+)\1/g, spec: 2, quote: 1 },
    { pattern: /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/g, spec: 2, quote: 1 },
    { pattern: /\burl\(\s*(['"])([^'"]+)\1\s*\)/g, spec: 2, quote: 1 },
  ];
  for (const item of quoted) {
    for (const match of text.matchAll(item.pattern)) {
      pushSpecifier(found, seen, match[item.spec] ?? '', match[item.quote] ?? '');
    }
  }
  const bare = [
    /@import\s+url\(\s*([^)'"\s]+)\s*\)/g,
    /@import\s+([^'"\s();]+)\s*;/g,
    /\burl\(\s*([^)'"\s]+)\s*\)/g,
  ];
  for (const pattern of bare) {
    for (const match of text.matchAll(pattern)) pushSpecifier(found, seen, match[1] ?? '', '"');
  }
  return found;
}

/** 相对路径、@/ 和以 docs/ 开头的说明符解析到仓库相对路径。包名返回 null。 */
export function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const spec = specifier.split(/[?#]/)[0];
  if (!spec || SKIP_SPEC.test(spec)) return null;
  const from = cleanRel(fromFile);
  if (spec.startsWith('@/')) return path.posix.normalize(`src/${spec.slice(2)}`);
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  }
  if (spec === 'docs' || spec.startsWith('docs/')) return path.posix.normalize(spec);
  return null;
}

const RESOLVE_EXTS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm',
];

/**
 * .dockerignore 的 `uploads` 按文件名匹配目录，不匹配 uploads.ts。
 * 先落到打包器会打开的那个文件，再套排除规则。
 */
function fileDockerWouldCopy(root: string, resolved: string): string | null {
  const candidates: string[] = [];
  if (path.posix.extname(resolved)) candidates.push(resolved);
  else {
    candidates.push(resolved);
    for (const ext of RESOLVE_EXTS) candidates.push(resolved + ext);
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) {
      candidates.push(`${resolved}/index${ext}`);
    }
  }
  for (const rel of candidates) {
    try {
      if (statSync(path.join(root, ...rel.split('/'))).isFile()) return rel;
    } catch {
      // 这个候选不在检出里
    }
  }
  return null;
}

export function contextViolations(
  file: string,
  source: string,
  rules: IgnoreRule[],
  root?: string,
): ContextViolation[] {
  const violations: ContextViolation[] = [];
  for (const specifier of moduleSpecifiers(source)) {
    const resolved = resolveSpecifier(file, specifier);
    if (resolved === null) continue;
    if (resolved.startsWith('..') || resolved.startsWith('/')) {
      violations.push({ file, specifier, resolved, reason: '解析到仓库外' });
      continue;
    }
    const target = root ? (fileDockerWouldCopy(root, resolved) ?? resolved) : resolved;
    if (isDockerignored(target, rules)) {
      violations.push({ file, specifier, resolved: target, reason: '被 .dockerignore 排除' });
    }
  }
  return violations;
}

export function sourceFilesInContext(root: string, rules: IgnoreRule[]): string[] {
  const files: string[] = [];
  const visit = (relDir: string) => {
    const abs = relDir ? path.join(root, relDir) : root;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_WALK.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isDockerignored(rel, rules)) visit(rel);
        continue;
      }
      if (SCAN.test(entry.name) && !isDockerignored(rel, rules)) files.push(rel);
    }
  };
  visit('');
  return files;
}

/** src/ 下被 .dockerignore 排除的 .ts/.tsx/.js/.mjs 等源码（含 route、page）。 */
export function excludedSourceViolations(root: string, rules: IgnoreRule[]): ContextViolation[] {
  const violations: ContextViolation[] = [];
  const visit = (relDir: string) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_WALK.has(entry.name)) continue;
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(rel);
        continue;
      }
      if (!SOURCE.test(entry.name) || !isDockerignored(rel, rules)) continue;
      violations.push({ file: rel, specifier: rel, resolved: rel, reason: '源码被 .dockerignore 排除' });
    }
  };
  visit('src');
  return violations;
}

export function checkImageContext(root: string): { files: number; violations: ContextViolation[] } {
  const rules = parseDockerignore(readFileSync(path.join(root, '.dockerignore'), 'utf8'));
  const files = sourceFilesInContext(root, rules);
  const violations: ContextViolation[] = [];
  for (const file of files) {
    const abs = path.join(root, file);
    if (!statSync(abs).isFile()) continue;
    violations.push(...contextViolations(file, readFileSync(abs, 'utf8'), rules, root));
  }
  violations.push(...excludedSourceViolations(root, rules));
  return { files: files.length, violations };
}

export function reportContext(root: string): number {
  const { files, violations } = checkImageContext(root);
  if (violations.length) {
    console.error(`镜像构建上下文有 ${violations.length} 个被 .dockerignore 排除的引用或源码：`);
    for (const hit of violations) {
      console.error(`${hit.file}: ${hit.specifier} -> ${hit.resolved}（${hit.reason}）`);
    }
    return 1;
  }
  console.log(`已检查 ${files} 个构建上下文源文件，没有引用被 .dockerignore 排除的路径。`);
  return 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.exit(reportContext(root));
}
