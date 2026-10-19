# BR-04：Windows 内测候选安装、升级与卸载隔离指导

状态：安装隔离指导已完成，实际安装/升级/卸载未执行。本文件入场核对未修改版本；后续根任务已按40统一package/lock三个根版本字段为1.4.0。当前用户要求先做其它产品修改，候选打包与包内验收暂停，没有生成本轮安装包。本文件不是安装验收通过记录。

依据为当前 `electron-builder.base.yml`、`electron-builder.win.yml`、`build/windows/installer.nsh`、`sandbox-permissions.ps1`、`src/main/index.js`、`services/app-update.js`、`NotificationService.js` 及安装中的 electron-builder 26.15.3 NSIS 模板。只支持 Windows 10/11 x64。

## 1. 当前安装与运行身份

下表保留入场核对的身份风险；其中平行候选独立CLSID、exe等建议属于第3节历史备选，当前不实施。正常1.4.0沿用生产身份，在可恢复Windows VM或独立测试机器中验证，不建立另一套内测身份。

| 项目                | 当前实际值/行为                                                             | 隔离风险与后续要求                                                                         |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| package / lock 版本 | 入场时三个根字段均为 `1.3.0`；现已统一 `1.4.0`                              | 使用正常版本和包名；不增加内测发行标识，见40                                               |
| builder appId       | `com.abandon.note`                                                          | 与运行时 AUMID 一致，但仅覆盖 builder 不会改变 main 中硬编码身份                           |
| NSIS guid           | `41249b74-bbe0-5d8d-8a9d-7f1bd6f04a19`，明确沿用旧安装身份                  | 使用该 guid 的候选会走正式安装的升级/卸载项；本机不能用它覆盖用户安装                      |
| productName / exe   | `Abandon便签` / `AbandonNote.exe`                                           | UI 名称不是完整隔离；exe 名与进程检查、ACL critical file 绑定                              |
| notification AUMID  | packaged 为 `com.abandon.note`；dev 为 `便签`                               | 真实安装测试不能沿用正式通知身份或改指旧通知的激活目标                                     |
| toast CLSID         | packaged `{1CBE300C-E243-4C77-8BA9-1068B748F17E}`；dev 使用另一个固定 CLSID | 候选需独立 CLSID；旧通知点击测试在 VM 中保留原身份验证                                     |
| protocol            | builder 与 main 均为 `abandon-note`                                         | NSIS 可在应用启动前注册；不能用运行时 flag 作为安装器隔离                                  |
| userData            | main 先读取 Electron 已决定的路径，再 setName('便签')，并恢复原路径         | 不能假设 productName 变更就隔离；候选需显式固定并回读独立绝对路径                          |
| single instance     | main 调用 `app.requestSingleInstanceLock()`                                 | 验证候选不会唤醒/退出正式实例；不要凭配置值认定互斥已分离                                  |
| 自启动              | `set-auto-start` 调用 `app.setLoginItemSettings` 后 OS 回读                 | 没有 integration flag 的写入防护；测试该开关需独立身份和安装路径                           |
| 卸载数据            | `deleteAppDataOnUninstall: false`                                           | 默认保留数据；NSIS 模板的显式 `--delete-app-data` 仍能覆盖默认，测试不得对正式资料传该参数 |
| 首次安装启动        | `runAfterFinish: true`                                                      | 生产 customInstall 成功后允许启动；失败 `1603` 必须不启动，但并非整个安装事务回滚          |
| sandbox ACL         | Repair 仅修 `$INSTDIR`，先保存 DACL，校验 `AbandonNote.exe` 等固定布局      | 隔离候选改 exe 名时也要同步 critical file 参数/校验；不能为省事关闭 sandbox/GPU            |

`ABANDON_INTEGRATION_TEST=1` 只在部分运行时逻辑跳过协议注册、远程或更新等。它不会改 NSIS guid、安装/卸载注册、shortcut、installer 的 protocol 注册，也不会自动改 toast CLSID、userData 或自启动写入。因此不能据此在当前用户账户安全安装正式身份包。

## 2. 优先验收路径

**先选有快照的隔离 Windows 测试环境，保留生产身份验证真正的升级链。** 在 Windows 10/11 x64 VM/独立测试机器的新账户中，安装旧正式版本，准备该账户的自有示例资料，创建快照；再安装本次候选。正式 guid 的覆盖升级、protocol/shortcut/AUMID 与旧 toast 的兼容性才可按真实行为核验。当前并未证明本机已有可用 VM 或 Windows Sandbox，也没有创建它们。

同机另一个账户只隔离 HKCU 和该账户资料；提权后的 HKLM 安装、所有用户快捷方式及按名字结束进程仍可能跨账户。不能只创建新账户就宣称完全隔离。独立机器/可回滚 VM 是真实生产身份安装的优先路径。

按最新决策，本次不另建平行候选发行身份。正常1.4.0产物的安装/升级/卸载放在可恢复Windows VM或独立测试机器验证。本机后续可做独立目录/测试自有资料的包内启动验证；它不等同安装验证，当前也已暂停。

## 3. 历史备选：同机平行候选隔离设计（当前不实施）

以下是用户确认同一正式1.4.0产物之前的备选设计，保留其风险依据，不列入当前修改任务或交付门槛。当前方案沿用正常生产身份，在隔离Windows环境验收；不得据本节新增候选身份、渠道或运行时环境变量。只有用户以后明确要求此路线时才重新评估，不自动实施下面的步骤。

1. **一个构建身份 owner。** 从打包元数据或构建生成的只读标记识别候选，给出明确有限的 candidate identity。builder、运行时和验收工具读取同一份身份；正常正式包缺候选标记时使用现有生产值。记录核心版本、内测序号、来源、输出路径和身份 hash。
2. **完整身份集合。** 候选独立 appId、NSIS guid、productName/shortcut/uninstall display、package name、protocol、toast CLSID、userData/sessionData 和 exe 名。一次候选升级链中 guid/appId/protocol/CLSID 必须稳定，不按每次启动随机生成；两个候选独立安装测试才使用不同完整身份。
3. **先设数据路径，再初始化资源。** main 的身份解析在日志、数据库、single-instance、通知激活和远程 identity 创建前完成。显式使用 test-owned 绝对路径，拒绝生产路径/父目录/reparse 边界。包内冷启动回读实际 userData、sessionData 与 DB/log/附件/壁纸路径。测试数据由 fixture/用户批准的离线副本提供，不读取、复制、迁移或清空当前正式资料。
4. **协议与通知一致。** builder protocol、main `APP_PROTOCOL`、notification activation、NotificationService 生成的链接必须一致。candidate shortcut AUMID 与 runtime AUMID/CLSID 同步；warm/cold 激活只落在候选进程。用实际 Windows 读口核对注册目标，不只断言配置文本。
5. **自启动隔离。** 候选开关调用的 entry 身份/目标必须独立且可回读；先记录本候选条目，再开/关，核对正式条目未变。卸载后单独核对候选 startup entry；默认 NSIS 卸载配置不能作为已清理的证据。不要扫描或删除所有 Run 项。
6. **进程检查必须隔离。** 当前 NSIS `allowOnlyOneInstallerInstance.nsh` 在 PowerShell 可用时按 `$INSTDIR` StartsWith 查找/结束进程；缺 PowerShell/Get-CimInstance 或策略 Restricted 会 fallback 到按 exe 文件名的 taskkill。相同 `AbandonNote.exe` 不能保证不误结束正式实例，且纯 StartsWith 没有目录分隔边界。候选使用独立 exe 名，并同步 sandbox critical filename；或使用候选 `customCheckAppRunning` 只核对规范化 exact install directory 和 owned PID，缺少可验证能力时停止，不 fallback 泛名字杀进程。整个测试仍不得终止正式便签、Codex、无关 Electron 或系统进程。
7. **ACL hook保持真实约束。** 如果候选 exe 改名，给权限脚本增加明确有限的 expected executable 传入/校验，并让 installer 与只读 diagnostics 使用同一值；生产默认仍为 `AbandonNote.exe`。保留先持久化完整 ACL backup、拒绝已知 Deny/reparse、不动父目录/资料、仅 RX、成功才继续启动等行为。不要在临时目录布置一个假的 `AbandonNote.exe` 使校验通过。
8. **包的闭包。** 保留 beforePack/afterPack 的原生 allowlist、DLL ABI、Qt 运行库/plugins、ASAR与日志 Worker 检查。候选身份调整不能导致漏打包 `resources/diagnostics/sandbox-permissions.ps1`、capture runtime 或 native DLL。exe 名改变也要核对 package smoke、diagnostic collector 和所有 source-text consumer。
9. **卸载清理只按 owner。** 卸载前记录候选 guid/protocol/AppID/CLSID、shortcut 目标、startup 与资料 hash。卸载后只读对照：候选安装/卸载/shortcut/协议关联按预期处理、正式条目完全相同、默认候选资料仍保留。测试 finish 时清理它自身的保留资料另作独立阶段；先验证绝对 owned path，再删除。`--delete-app-data` 在隔离 VM 单独测，不混入用户默认卸载流程。

建议修改范围（若采用同机路线）：独立 candidate builder config/身份元数据、main 身份初始化与依赖注入、installer hook、sandbox permissions/diagnostic expected executable、所触及的包内与身份测试。由父任务集中管理 manifest/CI。不要通过改巨型全局 context 扩大此次范围。

## 4. 内测标识与现有更新策略

当前 `AppUpdateService.normalizeVersion` 只接受 `X.Y.Z`，去掉可选 v 后不接受 prerelease 或 build metadata。`normalizeRelease` 主动过滤 draft/prerelease。`check()` 在 try 之前调用 `getTargetArtifact(currentVersion)`，因此把 package.version 直接改成 `1.4.0-beta.1`，即使 checkEnabled=false 仍会在前置校验抛错；现有单元测试也明确拒绝 beta 版本。不能为标内测就悄悄扩大正式更新策略。

用户最新决策取代此前独立内测序号建议：内测与正式使用同一 `1.4.0` 版本和正常安装包名，验证通过后发布同一产物，不新增beta渠道或发行身份。package/lock三个根版本字段已按40统一1.4.0；本节前表的1.3.0是只读入场记录。用户随后要求暂不生成安装包，候选打包与包内验收暂停，实际安装/升级/卸载仍未执行。

正常1.4.0产物在隔离Windows环境中按真实用户行为验收，保留现有稳定更新策略。测试群通过且文件未变时直接发布同一产物，测试用户无需重新安装同一文件；如反馈导致代码变更，则记录新产物与局部重验结果并提供修正版。此前beta转正式或同版本迁移提醒建议已取消，不据此增加渠道逻辑。

不运行 GitHub release workflow、不打 v1.4.0 标签、不公开上传候选、不改稳定release附件/README。正式发布仍执行 release-abandon-note 技能的后续授权流程；本阶段只取该技能的检查/拟稿约束。

## 5. 安装前到卸载后的具体验收

所有证据属于同一个固定候选来源/构建/产物 SHA256；记录 Windows 版本、账户/安装范围、路径、实际 exe、AUMID/CLSID/protocol、userData、ABI及Qt版本。表中“必需”指采用该验收路线后的完成条件，目前均未运行。

| 阶段       | 实际操作                                          | 必需 oracle / 失败条件                                                                                              |
| ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 安装前清点 | 测试机/VM快照；或候选owned身份预检                | 无正式身份冲突；路径规范化且不在真实资料；记录registry/shortcut/startup前值；缺隔离证据则停                         |
| 首次安装   | 安装至测试目录，使用真实NSIS生产hook              | 正确guid卸载项/shortcut/protocol、正确exe；ACL backup和verified；应用冷启动正常且sandbox/GPU正常；失败1603不启动    |
| 核心资料   | 新建/编辑/附件/壁纸/提醒/模板/三视图、退出/冷启动 | SQL与文件一致，实际持久数据读回；关闭后的草稿行为符合会话契约；通知与自启动仅属于测试身份                           |
| 同身份覆盖 | 安装下一候选到相同测试身份/目录                   | 单一卸载项、资料/附件hash及行为保留、ACL新增文件正确、shortcut保留策略准确、旧进程有界结束                          |
| 旧正式升级 | VM中旧包->候选，保持正式生产身份                  | 真正生产guid升级不多出卸载项；真实旧版本fixture迁移/backup/恢复、旧protocol/toast激活兼容；不能用新guid平行安装替代 |
| 升级失败   | 自有路径Deny/不可继承/backup写失败等受控条件      | 1603与不启动；保留已解压/已注册残留和ACL报告；不声称回滚完成；修复条件再试可恢复                                    |
| 包内诊断   | 日常/深度开关，导出生产日志与系统快照             | 包内Worker可用、尾批/脱敏正确、ACL Inspect只读；采样缺失/环境错误准确呈现                                           |
| 默认卸载   | 候选或VM测试安装的真实uninstaller，不传删资料flag | 安装/快捷方式/关联按实际设计清理；默认资料保留；startup/toast遗留单列；正式身份前后不变                             |
| 再安装     | 相同测试身份重装并冷启动                          | 默认保留资料仍可读，旧附件/设置契约正常；不从空库假装验证资料保留                                                   |
| 测试清理   | 关闭owned进程，清理本次owned artifacts/注册/目录  | 所有清理有记录；保存失败证据；先核对exactpath/owner，不跨shell拼接删目录；不把cleanup失败抹成passed                 |

运行前准备的局部验证范围：身份解析与当前update契约、sandbox permissions/hook、package-native config/package smoke及被实际修改的diagnostic consumers；真实安装/升级/卸载只在已验证隔离环境运行。构建使用固定Node并过滤Volta子进程路径，一开始在适合缓存/Windows资源的执行环境运行，始终 `--publish never`。这里只规定范围，不运行任何命令。

## 6. 停止条件与仍需外部环境的部分

- guid/appId/protocol/CLSID/userData/shortcut/startup任何一项指向用户正式身份，或installer进程检查可能泛杀同名进程：停止同机安装，先完成隔离或转VM。
- 只有源码/配置/包内列表正确，没有真实安装/冷启动/业务/卸载结果：状态仍为待验收。
- 缓存、rcedit、Qt、ACL、PowerShell或交互桌面在业务断言前阻断：记录环境阻塞，不算代码失败或通过。
- Windows10/11真实通知点击、标准用户提权/所有用户安装、企业策略、混合DPI/双屏与客户GPU需要对应环境；不能由本机fixture顶替。

本文件入场只读核对和历史备选方案继续保留；后续版本修改以40为准。未构建本轮候选，未安装/升级/卸载、未调整系统/注册或正式资料。恢复验收后使用正常产物在可恢复VM或独立测试机器验证生产身份链，按实际环境记录证据；当前不实施同机平行身份路线。
