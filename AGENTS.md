# Repository agent instructions

涉及 `src/renderer` 的界面、CSS、主题、边线、背景、控件或浮层改动前，必须完整阅读并遵守 `docs/UI_DESIGN_STANDARD.md`。

不得在组件内新增与该标准冲突的中性灰色或局部边线体系；确需例外时，应在代码注释中说明其语义或绘图用途。

## 测试策略

- 默认执行局部测试：只运行本次新增或修改功能直接相关的测试文件，以及该功能必需的构建或平台集成测试。
- 不得默认运行 `npm test`、`npm run test:window-frame:win` 或其他全量回归命令。
- 只有用户明确要求“全量测试”“完整回归”“发布验证”等情况时，才运行全量测试。
- 如果修改公共模块、影响范围难以准确判断，应先说明风险和建议扩大的测试范围，但不得自行升级为全量测试。
- 确定局部测试范围时，以本次任务实际修改的文件和功能边界为准，不得把工作区中原有的其他未提交修改自动纳入测试范围。
- Vitest 测试优先按具体测试文件运行，例如 `npm run test:unit -- tests/example.test.js`。由于部分测试通过读取源码文本进行断言，不得只依赖 Vitest 的 `related` 或 `--changed` 自动推断测试范围。
- 涉及 Electron 跨进程、真实窗口、数据库、文件存储或 Windows 原生能力时，应运行对应的专项集成测试；专项测试所必需的构建不视为全量测试。
- 完成任务时必须列出已运行的测试、未运行的全量测试，以及尚未覆盖的风险。

## Windows 测试运行环境

- 本机 PATH 会优先解析到 `C:\Program Files\Volta`，但 Codex 的受限工作区无法可靠访问 `C:\Users\Admin\AppData\Local\Volta`。运行 Vitest、ESLint、electron-vite 等局部验证时，应从第一条命令开始显式使用 `C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe` 调用对应的项目内脚本，不得先运行一次已知会命中 Volta 的 `npm`、`npx`、`node` 后再重试。
- 如果工具会继续派生 `node`、`npm` 或 `npx` 子进程，必须同时为该命令设置不会优先命中 Volta 的 PATH，或改为直接调用 `node_modules` 中的 JavaScript 入口；不能只替换最外层命令。
- 真实 Electron 窗口、Chromium、GPU、DPAPI、窗口层级、拖动及其他 Windows 原生专项测试需要访问工作区外的用户缓存和桌面资源。对此类已知不适合受限沙箱的测试，应一开始就申请在沙箱外执行，不得先在沙箱内制造一次预期的启动失败。
- `electron-builder` 打测试包时同样必须避免其依赖收集子进程重新命中 Volta；如果受限沙箱无法满足其缓存或子进程要求，应直接申请在沙箱外运行，并继续遵守 `--publish never` 等本地测试包约束。
- Volta 目录权限、Chromium 缓存、DPAPI 或 GPU 子进程在业务断言前导致的退出，只能记录为运行环境阻塞，不能算作测试通过或代码失败。切换到合适环境后，应以同一专项的最终退出码和业务断言作为有效结果。
