# KTX2 / Basis 转码器（站内托管）

three 自带的 `basis_transcoder.js` 用 Emscripten embind 编译，运行时会调用 `new Function()`，
在本站 CSP（script-src 不含 'unsafe-eval'）下会被拦截，KTX2 贴图模型一直停在“加载中”。

这里的文件由 [basis_universal](https://github.com/BinomialLLC/basis_universal) `webgl/transcoder` 重新编译，
在 CMakeLists 的 LINK_FLAGS 里加了：

    -s DYNAMIC_EXECUTION=0 -s INCOMING_MODULE_JS_API=['wasmBinary','onRuntimeInitialized','locateFile']

（emsdk latest，`emcmake cmake -G Ninja .. && ninja`）。接口与 three 的 KTX2Loader 兼容。
