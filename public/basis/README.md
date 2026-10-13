# KTX2 / Basis 转码器（站内托管）

three 自带的 `basis_transcoder.js` 用 Emscripten embind 编译，运行时会调用 `new Function()`，
在本站 CSP（script-src 不含 'unsafe-eval'）下会被拦截，KTX2 贴图模型一直停在“加载中”（#49）。
这里的文件是重新编译的版本，不使用 eval，接口与 three r186 的 KTX2Loader 兼容。

## 版本

| 组件 | 版本 |
|---|---|
| basis_universal | commit `99f52d63aa6799cbdaecfe977111dc5ec3b31d47`（BinomialLLC/basis_universal） |
| emsdk | `latest` 安装时解析为 Emscripten **6.0.12**（`5488e0871d46d19a3209988190fa6a653126256f`），emsdk 仓库 commit `35ff8a6` |
| CMake / Ninja | pip `cmake`、`ninja`（任意近期版本） |

## 产物校验（sha256）

    d5fd6ceb31de4c080b44bd36cbf3dbdec5b63f7598c5dd0001644c6a92f35896  basis_transcoder.js
    87b44a61f5eaff305cd633f04c4a4ac903e4f3b0261aa39e3fb4f1ce2f3f2a28  basis_transcoder.wasm

## 构建步骤

```bash
# 1) emsdk（固定版本）
git clone https://github.com/emscripten-core/emsdk.git && cd emsdk
./emsdk install 6.0.12 && ./emsdk activate 6.0.12 && source ./emsdk_env.sh
cd ..

# 2) 构建工具
python3 -m venv venv && ./venv/bin/pip install cmake ninja && export PATH=$PWD/venv/bin:$PATH

# 3) basis_universal（固定 commit）
git clone https://github.com/BinomialLLC/basis_universal.git && cd basis_universal
git checkout 99f52d63aa6799cbdaecfe977111dc5ec3b31d47
cd webgl/transcoder

# 4) 在 LINK_FLAGS 里加两个参数：禁用 eval；显式保留 KTX2Loader 传入的 wasmBinary
sed -i "s/-s ASSERTIONS=0 /-s ASSERTIONS=0 -s DYNAMIC_EXECUTION=0 -s INCOMING_MODULE_JS_API=['wasmBinary','onRuntimeInitialized','locateFile'] /" CMakeLists.txt
grep -c "DYNAMIC_EXECUTION=0" CMakeLists.txt   # 应输出 1

# 5) 编译
mkdir b2 && cd b2
emcmake cmake -G Ninja .. && ninja

# 6) 复制到站点并校验
cp basis_transcoder.js basis_transcoder.wasm <repo>/public/basis/
grep -c "new Function" basis_transcoder.js      # 应输出 0
sha256sum basis_transcoder.js basis_transcoder.wasm
```

修改后的完整 LINK_FLAGS：

    --bind -s ALLOW_MEMORY_GROWTH=1 -O3 -s MALLOC=emmalloc -s MODULARIZE=1 -s EXPORT_NAME=BASIS -s ASSERTIONS=0 -s DYNAMIC_EXECUTION=0 -s INCOMING_MODULE_JS_API=['wasmBinary','onRuntimeInitialized','locateFile'] -s EXPORTED_RUNTIME_METHODS=['HEAP8']

验证：`pnpm build && pnpm start` 后打开 /en/products，控制台不应有 `unsafe-eval` / CSP 报错，KTX2 模型卡片进入可交互状态。
