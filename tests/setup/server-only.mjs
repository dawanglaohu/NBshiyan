// 测试专用：让 `import 'server-only'` 在 node 测试里解析成空模块（server-only/empty.js，即 react-server 条件下的导出）。
// Next 构建时由 Next 自己按 server / client 层解析（客户端组件 import 仍会构建失败），这里不影响构建。
// node 测试默认条件会解析到 server-only/index.js（直接 throw），所以只在测试进程里改指向。
import { createRequire, register } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// exports 只开放 "."，所以从 index.js 的目录找 empty.js
const EMPTY = join(dirname(require.resolve('server-only')), 'empty.js');

// tsx 按 CJS 加载 .ts 时走 require()
const Module = require('node:module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'server-only' ? EMPTY : orig.call(this, request, ...rest);
};

// 按 ESM 加载时走 resolve hook
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, n) { return s === 'server-only' ? { url: ${JSON.stringify(pathToFileURL(EMPTY).href)}, shortCircuit: true } : n(s, c); }`
    )
);
