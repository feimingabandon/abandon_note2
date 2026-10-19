# BR-02 Qt UI 复制反馈的剪贴板隔离指导

日期：2026-10-10。状态：初轮隔离实现已构建，真实专项出现两项失败；原因已核对，测试窄修已落盘。用户要求等待后续产品修改，不生成安装包；当前只做静态收尾，不重建或运行Qt。新实现尚未通过编译和真实专项，不预填通过。

## 问题与范围

`native_capture/tests/ui_test.cpp` 的 `completionFeedbackOutlivesOverlay` 在真实桌面进程中遍历copy和quickSave。copy调用生产 `CaptureEngine::output`，进入 `Capture::writeClipboardImage` 的 `OpenClipboard/EmptyClipboard/SetClipboardData`，确实可能覆盖当前用户剪贴板。其它该文件的“copy动作”仅触发受控overlay output回调，不进入生产剪贴板写入，不应为了隔离一个场景改变全部UI断言。

已有 `clipboard_test.cpp` 在创建QApplication前绑定独立WindowStation和Desktop，可作为隔离依据；本次不改它，也不整体隔离UI suite。生产截图、层级、坐标、剪贴板实现不修改。

恢复点：`tmp/beta-readiness/qt-ui-clipboard-before-20261010-150611-569/`，包含入场 `ui_test.cpp` 与相关源码/runner/CMake身份。恢复只能恢复本批UI测试文件，不能覆盖工作区其它dirty。

## 修改步骤

1. 同一个UI测试exe增加内部子进程模式；普通入口仍创建真实桌面的QApplication并运行原suite。
2. 普通 `completionFeedbackOutlivesOverlay` 先启动该exe内部模式执行copy场景，随后继续自己原来的quickSave、图片/路径反馈、overlay删除，以及真实桌面再次capture前反馈消失的断言。
3. 子模式在QApplication之前使用Windows允许的系统命名非可见WindowStation，并新建唯一Desktop，调用并验证 `SetProcessWindowStation/SetThreadDesktop`。绑定前检查station与原名称不同、不为WinSta0且无WSF_VISIBLE；绑定后核对实际名称和desktop，复制前再复核。系统station名称属于logon会话，不保证每child唯一，Qt GUI与剪贴板专项必须串行。只有验证完成后才允许复制。
4. 子模式只执行原case中的copy分支：生产engine.output(copy)、session结束、overlay销毁、反馈可见/文案、实际私有剪贴板图像像素。使用Windows Qt插件，不以offscreen或stub替代生产copy。子模式不执行真实桌面capture。
5. 父进程用私有attempt目录与token启动子进程，保存stdout/stderr、QTest文本/JUnit与隔离报告。核对token、子PID、当前station/desktop验证、QTest完成、资源清理、唯一业务case；失败、skip、缺报告、未知目标、超时、崩溃或清理不完整都失败，不只检查exit0。
6. QApplication销毁后恢复子进程原station/thread desktop，再关闭它创建的资源。错误先记录、只处理自有子进程。没有读取/保存/恢复当前用户剪贴板，没有切换用户可见desktop。

不新增test/helper资产，不改CMake、manifest/domain或全局runner。证据目录优先使用现有 `ABANDON_CAPTURE_TEST_RESULT_DIRECTORY`，缺省为私有临时目录；失败证据保留。

## 静态与后续运行验收

静态核对：普通分支没有 `engine.output(copy)`；内部模式的复制只在隔离验证之后可达；其余UI方法完整保留；新模式不能运行其它UI方法；父进程拒绝子JUnit skip/失败/零业务case与错误token/PID；QApplication之前绑定资源，销毁后才清理。

构建/运行暂未执行，root安排与GUI截图和Vitest输入快照串行。计划命令使用AGENTS指定Node并过滤Volta，经既有focused入口只选 `native_capture/tests/ui_test.cpp`，默认rebuild。不直接执行旧exe或全Qt集合：

```powershell
$taskNode = 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:PATH = (Split-Path $taskNode) + ';' + (($env:PATH -split ';' | Where-Object { $_ -notmatch 'Volta' }) -join ';')
& $taskNode scripts/run-test-entry.cjs capture-native --file native_capture/tests/ui_test.cpp
```

该构建/真实专项需一开始申请沙箱外；结果以本次build前后身份、精确CTest、outer QTest与child报告为准。既有真实桌面case如果因锁屏QSKIP，记录为未覆盖，不称全UI通过。若有isolated Qt环境能力限制，失败保留并修正隔离方式，不回退到用户剪贴板、不整体改offscreen、不放宽为skip。

必要窄负验证：内部模式缺token/无效私有目录或隔离未就绪必须在复制前拒绝；父case缺/坏child报告不能通过。它们属于工具真实性，不追加产品极限压力。命令通过且copy确在独立资源、真实桌面断言仍执行后停止，不自动升级全量。

## 初轮静态完成证据（历史快照）

已修改 `native_capture/tests/ui_test.cpp`，新增同exe内部模式、私有WindowStation/Desktop guard、原copy分支在私有资源中执行、父进程结构化验收和有界自有child清理。失败时保留child stdout/stderr、copy文本/JUnit与隔离/清理报告；Win32恢复/关闭错误逐项记录。QTest子参数为固定ASCII参数，报告位于私有工作目录，避免中文路径命令行编码误报。

没有修改CMake、两个runner、clipboard_test或生产文件；不新增全局登记资产。静态底稿为 `tmp/beta-readiness/qt-ui-clipboard-static-review.json`，生成脚本只读源码并写这份JSON：原23个slot名称与顺序一致，除completion case外UI方法完整源码片段和首方法相同；复制/保存/session/反馈/图片的八条关键原断言仍在；七个关联owner源码SHA256与入场相同。

本批UI测试入场SHA256：`B009600575DBA1E0136BF7B5C6D719A98CB2FD6E9367C2A4C57DA196A574E0DE`；静态实现后：`896FDBB275DB0F637D556B528B8326CAD444A913E5B8ECB563EE8BF651BBA64B`。后续若继续修正实现，以新的运行attempt身份为准。

初轮已做指定改动区域clang-format、diff空白核对、文档格式和源码身份/保留片段核对。当时尚未构建或运行，本段只说明该历史snapshot，不覆盖后续真实失败。后续结果与修正如下。

## 首次真实验收、窄修与当前暂停边界

### 已保留的首次失败

root attempt `tmp/test-runs/2026-10-10T07-42-24-448Z-bsC0iN` 的指定UI构建成功；外层QTest报告48项case，46pass、2fail、0skip。`completionFeedbackOutlivesOverlay` 的独立child报告 `isolationWin32Error=5`、stationVerified/desktopVerified=false、qtestExitCode=2、cleanupComplete=true。旧报告只保存最终GetLastError，没有API阶段，不能单凭它断定创建还是绑定失败。`selectionAndExport` 的note双击实际source，但旧fixture期待copy。这次失败保留，不由后续静态修改撤销。

### 已执行的最窄Win32对照

中断之前已经完成私有Node→独立PowerShell P/Invoke样本，两轮均记录：相同WinSta0/Default会话中，自定义命名 `CreateWindowStationW` 在创建阶段返回ERROR_ACCESS_DENIED(5)；与现有clipboard_test一致的lpwinsta=nullptr方式返回系统非可见station，实际名称不同于WinSta0，SetProcessWindowStation/CreateDesktopW/SetThreadDesktop、flags/名称验证、恢复与关闭全部成功。

证据为 `tmp/beta-readiness/feedback-isolation-private-probe.json`；已有脚本 `probe-feedback-isolation.cjs` / `probe-feedback-isolation.ps1`。这些样本没有调用clipboard API，没有读取或切换用户可见desktop，没有Qt、Vitest、项目构建或共享test-runs写入。它们只确证本机Win32创建/绑定能力，不能替代新的Qt反馈业务验收，也不命名未确认的Windows策略或权限来源。用户暂停之后没有新增或重跑probe。

### 已落盘的测试窄修

唯一代码文件仍为 `native_capture/tests/ui_test.cpp`；本轮恢复点 `tmp/beta-readiness/qt-feedback-runtime-before-20261010-074632-119/` 保存入场SHA256 `896FDBB275DB0F637D556B528B8326CAD444A913E5B8ECB563EE8BF651BBA64B`。暂停时当前SHA256为 `6FF125EA8CA87F5FC1DCD095CF3F88F57E61FF368F45580F88C637323A76B429`。

1. 改为 `CreateWindowStationW(nullptr, ...)` 并读取Windows实际名称；唯一desktop继续UUID命名。新增绑定前验证、绑定后实际名称/flags验证，复制前继续现有独立复核。任何未就绪都停在copy前，没有用户剪贴板fallback、整suite offscreen或QSKIP。
2. 每次创建/绑定/读名/flags/验证/恢复/关闭记录stage、success和立即取得的Win32错误；额外记录failureStage、failureWin32Error、failureReason、observed名称、stationFlags与prebind验证。main不再用后续环境可能覆盖的GetLastError充当隔离失败原因；父case失败文本可读到准确阶段。清理只恢复真正成功绑定的资源，关闭自身句柄。
3. `selectionAndExport` 仍用note来源。Ctrl+C的copy动作、尺寸与完整像素断言保留；仅将普通双击期待改为source，并在双击前清空捕获值、双击后再次比较输出像素，要求实际新回调和当前来源完成契约。其它选择、微调、全选、布局、可见控件和preview保存断言不变。

来源完成依据是入场既有 `completionReturnsToRequestingForm` 对global/note/background分别copy/source的保护，以及当前 `CaptureOverlay.cpp:45` 主动作、`:47` 帮助文案、`:485` 双击和`:567` Enter分支。生产算法未改。`native_capture/README.md:32` 的“Enter/double click/Ctrl+C copies”与`:34` 的“Ctrl+Enter uses source”仍是旧契约文字；精确冲突已交root后续文档窄修，本owner未修改README。

### 已做与未做的静态核对

暂停后的只读比对确认slot名称/顺序仍为23/23；本轮仅selectionAndExport的slot正文变化，其余22项正文与本轮入场副本逐字符一致。system-named创建、复制前guard和phase/error字段均已落盘，`git diff --check`通过。没有覆盖初轮静态JSON，也没有把它签成新实现的证明。

新实现未做clang-format验收、C++编译或Qt执行，因而不能称“语法编译通过”或“48/48已通过”。用户暂停后的本批仅核对落盘与更新本指导；未构建、未Qt/Vitest、未打包、未安装/卸载或发布。后续恢复时先只检查/格式化本批区域，再由root串行重建指定UI专项，核对每API阶段、copy反馈像素/JUnit、资源清理和外层48项完整结果。此前两失败继续列为已知未验证项，不能放宽断言以通过。
