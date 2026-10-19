# BR-04 包内真实应用验收指导

日期：2026-10-10。状态：已保存指导、窄恢复点与专项脚本的静态实现；用户要求先继续产品改动，当前暂停候选固定与包内验收。未运行本专项GUI、未生成安装包、未安装或卸载，不预填通过。

版本决策：统一使用正式 `1.4.0` 与正常安装包名，不增加 `beta-1` 或其他内测发行标识。测试群验证通过后发布同一已验收产物，不能重新构建后沿用旧验收结论。`tmp/beta-readiness/candidate-1.4.0` 仅为后续本地证据目录建议，当前尚未固定候选；目录中的 `beta-readiness` 不代表发行版本。

当前暂停边界：只核对已落盘脚本的语法完整性并更新本指导，不继续增加脚本功能、不构建、不启动GUI、不打包。恢复执行须等后续产品改动固定并由用户重新启动发布前验收。生产GUID沿用；本机不安装生产身份候选的隔离边界继续有效。

恢复点：`tmp/beta-readiness/package-smoke-before-20261010-073530-364/`。仅保存本批将修改的 `tests/capture-package-smoke.cjs` 与原始SHA256。生产代码、版本、安装身份、manifest及runner由本批以外的owner负责，本专项不修改。

## 1. 候选与参数必须明确

旧脚本默认落到2026-09-29的目录，且只打印自写passed结果；改为必填 `node tests/capture-package-smoke.cjs <候选win-unpacked绝对路径>`，也允许runner显式传 `ABANDON_TEST_PACKAGE_DIR`，两者同时存在必须指向同一真实目录。禁止旧目录默认值，不从当前正式安装自动发现候选。

入口必须验证Windows x64、目录与真实 `AbandonNote.exe`、`resources/app.asar`、`resources/native_capture/AbandonCapture.exe`存在，记录精确candidate/exe/ASAR及输入driver SHA256。规范化真实路径，拒绝候选关键文件逃出目录；不修改安装器或启动正式安装。父代理冻结候选来源后传入该路径。

本专项所需本地driver为 `native_capture/build/bin/capture_input_driver.exe`；后续候选准备阶段应显式以 `-InputDriver` 构建，再用 `ABANDON_CAPTURE_INPUT_DRIVER` 传入已记录SHA256的本批driver。现有脚本仍接受显式driver或上述本地路径，必须存在并记录SHA256。包内app/native/Qt必须来自候选目录，不能靠development PATH补DLL；测试及runner均不静默构建driver。父代理负责产品改动固定后的必要 `build-app/native/capture` 构建与包布局验证，当前不执行。

## 2. 结果、资料与环境所有权

采用 `createAssertionRecorder` / `prepareTestProfile`，suite仍为本文件，mode固定 `node-packaged-app-candidate`。managed attempt的result、evidence、run token与profile由runner创建；profile必须在它拥有的TEMP内。直接运行创建独立script-owned profile并保留证据，不能将profile放到正式userData或让脚本自动删除用户资料。

给候选进程传 `--user-data-dir=<owned profile>` 与integration flag并回读 `app.isPackaged`、`app.getPath('userData')`、`process.resourcesPath`、`app.getAppPath`。清除开发native/app根目录覆盖和Qt环境变量；PATH只保留Windows系统目录。本专项不调用自启动或安装入口，不测试生产身份注册/升级/卸载，边界按34。

两次启动使用同一个owned profile，但必须是前一个应用及Qt helper真实退出后的新进程。记录PID、creationTime、exe与parent证据；同进程reload或换空profile都不能叫冷重启。

## 3. 原有真实保护保留

保留包内实际native capture启动、driver向verified helper发送F整屏与Ctrl+N、真实renderer截图草稿缩略图、真实ASAR image Worker导入、app-localQt目录、截图绑定保存并冷重启注册、两轮真实app/helper退出。不得用传入合成data URL替代native截图，也不把source-tree Worker当ASAR验证。

启动后通过包内只在integration暴露的既有hook观察ready/PID/directory；该hook不是mock。Inspector只负责操作已spawn的候选进程，不接入其他应用或随意复用缓存endpoint。

## 4. 截图前覆盖个人桌面

先确认本机实际只有一个显示器。通过本次候选进程创建test-owned、无框、置顶、不聚焦的全屏图案BrowserWindow覆盖整块真实display bounds，使用内置data HTML与固定色块，不读取外部网页或个人图像；等实际两帧绘制并核对窗口原生位置可见，再启动native整屏截图。

图案在截图结束及草稿图片加载完成前保持，且不得遮住截图原生选择层输入。保存pattern自身的安全截图/尺寸作为覆盖证据；截图只包含测试自有图案。若实际多屏或无法确认覆盖，停止并标环境缺口，不继续捕获个人桌面，也不伪造screen清单。

截图导入完成后销毁图案窗口，让诊断export不因不支持的测试fixture producer被误报partial。finally也关闭本次创建的pattern窗口。截图driver仅对本次已核实parent/exe/creationTime的capture helper输入，不能泛找同名窗口。

## 5. 便签、附件与冷重启读回

在真实“截图新建便签”表单填入唯一marker正文并点击其“创建便签”按钮，保留实际UI→preload→IPC→ASAR Worker→SQLite/附件提交链。使用正常查询API找唯一marker记录，不用替换create方法截获所谓成功。

保存后回读正文、附件列表/数量，验证原始附件真实文件位于owned profile；通过生产缩略图API读取非空图像data URL并记录解码字节哈希，当前缩略图是内存cache，不能伪称已写缩略图文件。记录原图内容哈希、尺寸与路径。冷重启后按相同note ID通过实际API再读正文与附件，再对比实际文件SHA256。缩略图出现只证明导入，不能代替 durable saved/重启保留。退出前不通过清空全部draft来掩盖尚未保存的fixture；需等提交及modal自然结束。

绑定保持原保护：会话enabled切换后保存唯一截图accelerator，退出后重启读取持久binding并确认默认enabled与真实globalShortcut注册。若快捷键被系统占用，保存准确runtime结果而非跳过注册断言。

## 6. ASAR日志Worker实际导出

在包内通过真实主窗口API开启深度、产生唯一结构化诊断marker、完成正常note读写，并从实际production导出入口保存到owned evidence JSONL。仅受控save dialog目标，保留freeze、renderer尾批、main/native flush、Worker snapshot与system snapshot。对话框替换必须finally恢复。

外层Node读取实际导出文件，检查marker、正确包内版本、`diagnostic-complete`、主renderer完整尾批与可用writer；不只查返回路径或stdout。记录SHA256/字节/业务记录数。证据中的ASAR路径、Worker源码/运行路径与非空生产JSONL联合说明包内Worker，不将应用启动一次视为Worker通过。

停止深度后确认日常。冷重启后再做导出，检查日志marker及持久note仍在同一profile；新session与新PID必须可见。使用测试自有便签与图案，不把个人正文或桌面存进证据。

## 7. 进程退出与失败清理

每次spawn保存parent PID、精确exe和OS creationTime；helper就绪后用Windows进程查询核实ParentProcessId是本次app PID且exe恰为candidate/resources/native_capture/AbandonCapture.exe，保留其creationTime。非正常退出时先尝试实际app.quit并等待；需要终止时立即重查同一PID/parent/exe/creationTime，只有完全匹配的owned app/helper才可结束。

禁止按名字taskkill、进程树泛kill、仅凭旧PID结束、结束正式实例/Codex/其他Electron。身份查询失败或不匹配时保留证据并报告cleanup失败，不能fallback到泛kill。测试本次spawn的短driver由execFile的timeout/killSignal与明确句柄管理，不触及其他driver。

正常路径必须确认两轮app退出码与helper已退出；cleanup本身不算业务完成。异常保留所有stdout/stderr、当前profile、Inspector错误、部分业务证据与已验证owned进程清理状态，recorder.completed=false。managed成功后runner删除它拥有profile；失败保留profile；script-owned正常也保留profile/导出便于复核。

## 8. 验收顺序与恢复

父代理先完成静态syntax/format/lint、mode登记、明确candidate参数和capture driver prerequisites，再验证固定来源包布局；真实专项按Windows沙箱外运行要求串行执行。只运行本文件及其必要候选/driver构建，不由本脚本触发全量测试。

实际结果应记录attempt/mode、候选SHA256、启动身份、display/DPI、真实截图/保存/重启读回、两次日志JSONL、绑定状态、app/helper身份与退出、cleanup。当前均尚未运行。独立目录包启动不是NSIS首装、覆盖升级、协议/通知注册、ACL安装修复或卸载验收；本机不安装生产身份候选，相关缺口不得被本专项passed掩盖。

恢复仅用上述窄恢复点还原本脚本，并由父代理撤销其mode/manifest接线；不还原整个dirty checkout，不删除失败attempt或改正式资料。保留旧真实保护的理由与新增业务判据，不为通过而关闭GPU/sandbox、放宽helper身份或skip截图。

## 9. 暂停时的准确状态与待收尾项

2026-10-10 已再次执行本文件对应脚本的 `node --check`，退出码0；本批先前的格式与ESLint静态检查也通过。上述结果只说明静态完整性，未证明候选业务、截图或包内Worker实际通过。

当前脚本仍使用240秒业务timeout，cleanup没有独立总体deadline。计划的210秒业务timeout、35秒独立cleanup余量和runner外层270秒尚未实施或联测，后续需一并收尾；不得仅延长外层timeout后声称清理已有界。失败spawn的close状态细化、Win11全屏fixture边框/圆角覆盖也属于尚未实施的检查项。

现有脚本记录 `app.getVersion()`，尚未含明确的 `expectedVersion === '1.4.0'` 断言；后续恢复验收时补齐候选与导出版本一致性核验。当前不存在固定候选、包内运行结果或NSIS安装验收结果，不完成固定候选或发布前验收结论。
