import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

export default [
  { ignores: ['.next/**', 'node_modules/**', 'public/**', 'next-env.d.ts', 'prisma/generated/**'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // gltf-progressive 的 useNeedleProgressive 只是给 loader 注册插件的普通函数，不是 React Hook
    files: ['src/components/three/ProductModel.tsx'],
    rules: { 'react-hooks/rules-of-hooks': 'off' }
  }
];
