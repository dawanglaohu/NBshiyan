import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 组件测试载体的构建脚本：所有路径从本文件位置推导，依赖从当前检出解析，
// 产物写调用方给的临时目录（argv[2]），不写仓库，不借用主目录。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node build.mjs <outDir>');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

// esbuild 不是直接依赖：经仓库已锁定的 tsx 解析（CI 与本地同一锁文件）。
const requireRepo = createRequire(path.join(REPO, 'package.json'));
let esbuild;
try {
  esbuild = requireRepo('esbuild');
} catch {
  esbuild = requireRepo(createRequire(requireRepo.resolve('tsx')).resolve('esbuild'));
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const gitText = (...args) => execFileSync('git', args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').trim();

function resolveFile(base) {
  for (const p of [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  for (const f of ['index.tsx', 'index.ts', 'index.jsx', 'index.js']) {
    const p = path.join(base, f);
    if (existsSync(p)) return p;
  }
  return null;
}

function makePlugin(dynamicImpl) {
  return {
    name: 'm2t6-carrier-alias',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === 'next/dynamic') return { path: path.join(HERE, dynamicImpl) };
        if (args.path === 'next-intl') return { path: path.join(HERE, 'stub-next-intl.tsx') };
        if (args.path === '@/i18n/navigation') return { path: path.join(HERE, 'stub-navigation.tsx') };
        if (args.path === 'virtual:globals-css') return { path: path.join(REPO, 'src', 'app', 'globals.css') };
        if (args.path === 'virtual:en-messages') return { path: path.join(REPO, 'messages', 'en.json') };
        if (args.path.startsWith('@/')) {
          const p = resolveFile(path.join(REPO, 'src', args.path.slice(2)));
          return p ? { path: p } : null;
        }
        if (args.path.startsWith('.')) {
          const p = resolveFile(path.resolve(path.dirname(args.importer), args.path));
          return p ? { path: p } : null;
        }
        return null;
      });
    },
  };
}

const builds = [
  { entry: 'entry.tsx', out: 'bundle.js', dynamic: 'dynamic-real.tsx', role: 'main' },
  { entry: 'entry-neg-model.tsx', out: 'bundle-neg-model.js', dynamic: 'dynamic-real.tsx', role: 'negative-model' },
  { entry: 'entry-neg-stub.tsx', out: 'bundle-neg-stub.js', dynamic: 'dynamic-stub.tsx', role: 'negative-stub' },
];

const outputs = [];
for (const b of builds) {
  const t0 = Date.now();
  const result = await esbuild.build({
    entryPoints: [path.join(HERE, b.entry)],
    bundle: true,
    outfile: path.join(OUT, b.out),
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    // three r186 DRACOLoader 在模块顶层 new URL(..., import.meta.url)；IIFE 里给同源基址，
    // 运行时仍由 ProductModel.tsx 的 setDracoDecoderLocation('/draco/') 覆盖。
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://carrier.local/_carrier/"' },
    absWorkingDir: REPO,
    nodePaths: [path.join(REPO, 'node_modules')],
    plugins: [makePlugin(b.dynamic)],
    metafile: true,
    logLevel: 'warning',
  });
  const inputs = Object.keys(result.metafile.inputs);
  const jsFile = path.join(OUT, b.out);
  const cssFile = path.join(OUT, b.out.replace(/\.js$/, '.css'));
  outputs.push({
    role: b.role,
    entry: b.entry,
    dynamicImpl: b.dynamic,
    js: { file: b.out, bytes: statSync(jsFile).size, sha256: sha256(readFileSync(jsFile)) },
    css: existsSync(cssFile) ? { file: path.basename(cssFile), bytes: statSync(cssFile).size, sha256: sha256(readFileSync(cssFile)) } : null,
    ms: Date.now() - t0,
    bundledModules: inputs.length,
    chain: {
      galleryScene: inputs.some((p) => /components[\\/]three[\\/]GalleryScene\.tsx$/.test(p)),
      productModel: inputs.some((p) => /components[\\/]three[\\/]ProductModel\.tsx$/.test(p)),
      three: inputs.some((p) => /[\\/]three[\\/](build|src)[\\/]/.test(p)),
      drei: inputs.some((p) => /@react-three[+\\/]drei/.test(p)),
      needleProgressive: inputs.some((p) => /gltf-progressive/.test(p)),
    },
  });
}

const manifest = {
  kind: 'm2t6-poster-carrier',
  taskOnly: true,
  notProductionRoute: true,
  generatedAt: new Date().toISOString(),
  repo: {
    head: gitText('rev-parse', 'HEAD'),
    tree: gitText('rev-parse', 'HEAD^{tree}'),
    status: gitText('status', '--porcelain'),
  },
  builds: outputs,
};
writeFileSync(path.join(OUT, 'build-meta.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ head: manifest.repo.head, tree: manifest.repo.tree, builds: outputs.map((o) => ({ role: o.role, js: o.js.bytes, css: o.css?.bytes ?? 0, ms: o.ms, modules: o.bundledModules, chain: o.chain })) }, null, 2));
