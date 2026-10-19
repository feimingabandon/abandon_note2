# 测试入口与异常留痕

日常按 `AGENTS.md` 运行直接相关的局部测试。默认入口要求明确选择，不再把空参数理解成所有测试；新增测试前先明确行为契约、触发条件和缺陷风险，不为可逆的小改动或源码写法本身增加镜像断言。

## 精确局部选择

```powershell
npm run test:unit -- tests/test-selection.test.js
npm test -- --file tests/test-selection.test.js --plan
npm test -- --file tests/test-selection.test.js
npm run test:db -- --file tests/note-duration-db.mjs --plan
node scripts/run-electron-window-tests.cjs --file tests/daily-report-electron.mjs --plan
npm run test:capture:native -- --file native_capture/tests/core_test.cpp --plan
```

`test:unit` 兼容具体文件位置参数，并要求登记的 unit/Vitest 角色。DB、窗口和 Qt 入口使用具体 `--file` 或 `--id`；未知路径、helper/fixture、越界路径、错误运行时和空选择都拒绝执行。`--file`/`--id` 可以重复，稳定去重。默认 `npm test` 也可以使用已人工核实登记的 `--feature`；禁止按文件名推测业务功能。

`--source` 只显示候选，不能自动升级成执行名单；仅源码候选时必须附 `--plan`。源码读取和 import 映射不是完整传递依赖，公共模块变更仍需要说明影响域，再明确选择。

`--plan` 只读显示选中项、完整 requires、平台前置、候选及原因，不创建运行证据目录，不启动测试/构建。实际执行只调度该明确范围与不可裁掉的前置。没有真实断言结果适配的 DB/GUI/原生域仍会 blocked/unproven，不能称为业务通过；这些域的迁移进度以阶段指导和实际报告为准。

Qt 的具体 core/selection/polish/pin_halo/ux/ui/clipboard 文件分别对应单个 CTest 名称；普通原生构建不顺带运行七项测试。`test:capture:native` 无参数拒绝执行，`-Test` 也必须具有具体 `-TestName`，显式 native 全集由专门全量入口负责。Qt/MSVC/真实桌面前置不齐时记录运行环境阻塞。

## 构建与显式集合

默认局部执行按已登记 build-app/build-native/build-capture/build-notice-preview 前置构建，不为普通单元任务自动启动完整应用或全部原生构建。`--build reuse-verified` 只有输入、工具链、输出哈希等来源证明与当前版本一致时才能复用；产物存在、旧构建退出 0 或手工记录版本号都不构成来源认证。失败的认证必须阻断并要求重新构建，不能静默使用旧产物。

窗口命名集合如 `node scripts/run-electron-window-tests.cjs window-frame --plan`、`... capture --plan` 仍作为明确集合保留。去掉 `--plan` 表示显式执行该集合，运行前会输出完整只读计划。`test:window-frame:win` / `test:electron:all:win` 的命名已表达集合范围，后者仍不等于完整验收；单项变动应调用具体文件入口。`test:daily-report:win` 已是一个精确文件入口，前置由登记依赖决定。

明确要求全量时运行：

```powershell
npm run test:full:win
```

在当前 Codex Windows 工作区，从首条验证命令就直接绕过 Volta；派生进程的 PATH 也要排除 Volta 并前置相同 Node：

```powershell
$testNode = 'C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$env:PATH = (Split-Path $testNode) + ';' + (($env:PATH -split ';' | Where-Object { $_ -notmatch 'Volta' }) -join ';')
& $testNode scripts/run-test-entry.cjs unit tests/test-selection.test.js
```

真实 Electron 与 Windows 原生窗口测试需要可交互桌面；在 Codex 中从第一次执行就申请沙箱外运行。脚本会串行测试并可能移动鼠标/窗口，运行时避免人工同时操作测试窗口。不要用 PowerShell 直接 `& electron.exe ...` 的瞬时返回作为测试通过证据。

全量入口包含单元、源码/测试 lint、原生 DLL 和应用构建、通知预览构建、数据库、存储、窗口/页面专项、成熟度验收、通知后台联调、缩略图基准。`test:electron:all:win` 只是常规窗口集合，不等于以上全量。通知后台专项依赖相邻 `abandon_note_server_light` 的 `.venv/Scripts/python.exe` 和既有 `web/dist`，只使用临时数据库和本地临时 HTTP 服务，不连接生产服务；该项不是服务器重新构建/部署验收。

需要重跑失败项时优先通过局部入口显式传入登记的 ID：

```powershell
node scripts/run-focused-tests.cjs --id tests/week-day-panel-electron.mjs --plan
```

局部重跑也保留完整构建依赖，不能裁掉未显式选中的 requires。不要把复用未经认证的旧构建结果称为当前源码的通过，也不要把一次局部通过称为发布验证。

## CI 与发布质量范围

普通 PR/push CI 用完整 Git 历史。PR 以事件 base/head SHA 的 merge-base 为起点，push 以 before/sha 精确差异为起点，只读取已提交差异，不把本地其他 dirty 文件加进范围。手动工作流必填完整 base SHA；全零、缺失、不存在的基线和错误历史一律非零拒绝，不猜 HEAD~1、不回退所有测试。

`scripts/run-ci-tests.cjs` 使用人工核实的基础设施消费者规则、直接修改的已登记 unit，以及 `scripts/test-domain-rules.cjs` 中已验收的具体叶模块。当前包括 settings/repository/DB/recovery/note 命令、app IPC/Host/geometry、启动退出、Blur/ZOrder/Dock/Drag/Presentation/Navigation/background、业务准入/服务装配/tray/activation/weather、列表/日历模型和设置表单。每条规则选择具体unit与必要真实专项，不从import图自动扩散。package.json 仅 scripts/格式变动才能走基础设施规则；依赖或其他元数据改动要求额外校验。registry 的 source/import/source-read 项仅作候选解释。主入口、公共schema/native等跨域或未映射改动仍返回 needs-domain-validation 和非零退出码，需明确对应域范围及结果；不会自行全量兜底。

测试与 CI 桌面目标仅支持 Windows；非 Windows 入口明确拒绝，不返回成功或转交职责。纯仓库文档变动返回 no-tests 和具体原因，可靠空差异返回 no-change；二者均不声称执行过测试。普通 CI 不默认调用 window-frame 全集或全部原生构建；有实际选定构建前置时才执行。真实输入/native专项须在具备桌面条件的环境执行，托管runner的模拟不能代替它们。

发布质量门槛使用显式 `npm run test:release:quality`，固定范围是全部登记 unit、原 DB 七项及附件/壁纸两项；可附 `-- --plan` 查看范围，不能用参数悄悄缩减。原发布版本校验、窗口验收、构建、打包、上传和 draft release 职责保留。缺少域结果适配时门槛会阻断，不为了让 workflow 变绿而降级为退出码证明。本地修改 workflow 不等于已运行 CI 或已获得发布授权。

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
