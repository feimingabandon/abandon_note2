# 测试入口与异常留痕

日常仍按 `AGENTS.md` 运行直接相关的局部测试。明确要求全量时运行：

```powershell
npm run test:full:win
```

在当前 Codex Windows 工作区，直接绕过 Volta：

```powershell
& 'C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/run-full-tests.cjs
```

真实 Electron 与 Windows 原生窗口测试需要可交互桌面；在 Codex 中从第一次执行就申请沙箱外运行。脚本会串行测试并可能移动鼠标/窗口，运行时避免人工同时操作测试窗口。不要用 PowerShell 直接 `& electron.exe ...` 的瞬时返回作为测试通过证据。

全量入口包含单元、源码/测试 lint、原生 DLL 和应用构建、通知预览构建、数据库、存储、窗口/页面专项、成熟度验收、通知后台联调、缩略图基准。`test:electron:all:win` 只是常规窗口集合，不等于以上全量。通知后台专项依赖相邻 `abandon_note_server_light` 的 `.venv/Scripts/python.exe` 和既有 `web/dist`，只使用临时数据库和本地临时 HTTP 服务，不连接生产服务；该项不是服务器重新构建/部署验收。

需要重跑失败项时可显式传入登记的 ID：

```powershell
node scripts/run-full-tests.cjs tests/week-day-panel-electron.mjs tests/maturity-electron.mjs
```

带 ID 是局部复测，默认复用现有构建；产品代码已变时必须显式包含 `build-native` / `build-app` / `build-notice-preview` 中相关项目，或重新运行完整入口。不要把复用旧构建的结果称为当前源码的完整通过。

## 如何读取结果

每次运行新建 `tmp/test-runs/<时间>-<随机标识>/`，不覆盖旧目录。

- `baseline.json` / `ending-snapshot.json`：版本、平台、范围、文件哈希，检查是否发生并行改动。
- `summary.json`：每项退出码、耗时、状态。failed 是待分析的失败，不自动等于功能 Bug；blocked 表示构建等前置失败、没有执行；timeout / launch-error / runner-error 单独区分。
- 每项 `stdout.log` / `stderr.log` / `result.json`：具体命令与原始输出。
- `diagnostics/`：退出后还能读取到的应用 JSONL；`artifacts/`：该次新生成的报告和截图。旧脚本自行清理的资料可能已不可读，不承诺能恢复。
- 失败保留本次临时目录；成功自动删除本次临时缓存。只清理由本运行器创建的目录，不清理用户应用数据。

单个脚本中有意注入错误、拒绝或进程崩溃的场景，应结合对应断言判断；不能把每条 error 都当成产品失败，也不能因为最终退出码 0 就无视异常日志。运行器自身的单元测试会故意模拟失败/超时来验证退出码和继续执行能力。

异常必须在日期报告中写明：场景、复现步骤、期望/实际、首次证据位置、分类依据、修改范围、复测目录/结果、尚未执行的后续断言。修复测试不得删除功能断言或把真实失败改为跳过。

本次记录见 [2026-09-22 全量测试及异常记录](2026-09-22-full-regression.md)。原始证据位于被 git 忽略的 `tmp/`，本地保留但不会自动提交；如需长期归档，应单独保存证据目录，注意诊断日志不保证绝对匿名。

后续按章程逐项执行的范围与结果见 [测试章程](2026-09-22-test-charter.md) 和 [执行结果](2026-09-22-charter-results.md)。新增窗口叠加矩阵已登记为 `tests/window-state-matrix-electron.mjs`，会进入后续全量与窗口合集；该项使用默认 GPU，完整执行可能需要数分钟。
