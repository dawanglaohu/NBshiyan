import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const require = createRequire(import.meta.url);
const baseDirectory = dirname(fileURLToPath(import.meta.url));

// pnpm 把 eslint-config-next 的插件放在它自己的依赖层里；ESLint 默认从工作目录
// 解析旧式插件名，那里并不存在这些包。这里用 Node 标准解析拿到它安装后的真实目录，
// 交给 FlatCompat 从该目录解析插件；包缺失时直接报错，不回退到缺规则的宽松配置。
let resolvePluginsRelativeTo;
try {
  resolvePluginsRelativeTo = realpathSync(dirname(require.resolve('eslint-config-next')));
} catch {
  throw new Error('eslint-config-next 未安装：先完成项目依赖安装再跑 lint（不提供缺规则的降级配置）。');
}

const compat = new FlatCompat({ baseDirectory, resolvePluginsRelativeTo });

export default [
  { ignores: ['.next/**', 'node_modules/**', 'public/**', 'next-env.d.ts', 'prisma/generated/**'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // gltf-progressive 的 useNeedleProgressive 只是给 loader 注册插件的普通函数，不是 React Hook
    files: ['src/components/three/ProductModel.tsx'],
    rules: { 'react-hooks/rules-of-hooks': 'off' }
  }
];
