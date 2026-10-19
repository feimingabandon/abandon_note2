# 毛玻璃开启后切换置顶：测试审查与原因定位

## 授权与阶段顺序

用户同意继续调查，并要求先排查测试代码问题，再仔细查原生原因；必要时增加日志。范围限定为本地 Windows 毛玻璃/置顶链路、对应测试和诊断，不运行全量回归，不修改 Apple 视觉、其他业务、安装或发布。

上一阶段恢复点为 `tmp/windows-only/windows-only-complete/inventory.json`。本阶段开始再保存测试、相关 owner、原生源码、DLL 与构建入口快照；所有新 attempt 独立，不覆写 `07-39-50-892Z-hXq5tc` 的正式失败或 `overlay-attempt-qZzEl0` 的诊断成功。旧结案文件与21保持其时证据，当前调查结果另记。

## 第一阶段：测试代码审查

逐项检查 `tests/native-leaf-runtime-electron.mjs`：独占profile及TEMP归属、SQLite种子key与schema、禁用远程请求、隔离协议注册、真实app来源及DLL来源、业务就绪条件、IPC await、550ms间隔与产品500ms节流、off/on顺序与历史状态、当前可见窗口、断言时点、snapshot、失败与清理分类。对照AppTitlebar的实际调用路径和已有blur/z-order专项。

需要区分三种结论：测试自身错误；合法但依赖历史顺序的组合场景；产品处理内部拒绝。不得凭一次通过排除测试或产品问题，也不能仅因结果不稳定删断言、延长产品等待或把原失败标成通过。

当前确认：原失败发生在 `await setWindowZOrderMode('top')` 的产品confirm，尚未执行该步任何后置断言；前33条与这一位置一致。550ms从前一个await结束后开始，未触发节流。原生测试读取的是实际app/原生getter，未自行写Win32层级。初审之外的就绪/隔离/用户动作差异继续核对，完成前不预填全部测试正确。

## 第二阶段：对照与诊断配方

测试审查完成后，按同一当前构建、独立profile、串行桌面执行以下对照；每次都保留原退出码、completed、断言、证据及清理，诊断成功不替代正式失败：

1. 原正式脚本无探针，明确保留关闭毛玻璃normal/top/bottom再开启normal/top/bottom的组合场景。
2. 窄场景区分从普通启用玻璃再置顶，与先置底再启用玻璃/退出置底；保持真实产品IPC和严格层级条件，列明从哪一初始状态进入。
3. 比较正式API与实际标题栏触发的同一handler；触发方式、窗口焦点、renderer-ready、presentation/Dock代次以及测试是否节流均记录。动作采样不被冒充物理按键或客户机认证。
4. 改进隔离探针，精确枚举同PID且类名为BlurOverlayWindow的窗口；不要要求遍历整个桌面256项后才能识别Overlay。匹配多个、枚举失败/截断必须保留不确定结果。原探针及其成功记录不修改。
5. 按请求采集parent/Overlay HWND、线程、实际topmost、owner、visible/iconic/cloaked、rect与前后链；只读取原生状态，不读标题/正文、不调用native setter。采样有界、关键区内存暂存、原返回/错误原样传递，记录采样本身耗时。

## 第三阶段：必要日志与修复判定

若实际失败仍只有 `zOrderSynchronized=false`，增加能说明原因的原生诊断：同步请求投递/去重/处理计数，最后请求/处理时间与线程，SetWindowPos结果与立即捕获的错误码，检查失败原因及夹层窗口状态。诊断不可阻止原返回、替代原错误、产生每帧日志或改变层级规则；正常操作只保留小快照，失败/显式诊断时记录。

新增native导出或运行契约必须同步ABI声明、FFI绑定、对应测试/manifest，重建DLL并执行实际载入与窗口专项。先审消费者和具体局部范围，不因native公共模块修改自动跑全量。仅增加日志也要保存原DLL恢复副本，核对真实加载路径。

根据证据分别处置：fixture或ready错误只修测试；实际band/位置错误修对应原生排层；请求未处理修队列/生命周期；检查误判修可见性/观测语义并保留真实夹层负例。不能以猜测选择修复，不把诊断后的通绿当红绿证明。

## 验证、停止与回退

局部unit优先选 `native-leaf-runtime.test.js`、`window-z-order-main-wiring.test.js`、`native-runtime-gate.test.js` 与直接新增诊断消费者；真实专项选原native-leaf及与实际修改相符的blur-z-order/窗口恢复具体脚本。必要app/native构建不属于全量。固定Codex Node并排除Volta，真实Electron从首次命令在沙箱外执行。

保存每次首次失败。源、DLL与out未冻结时不得并发构建或运行Vitest写依赖缓存；复用必须有当前来源核对。回退只从本阶段快照恢复实际变更文件及DLL，保留S7修复、Windows-only支持、用户dirty、数据库和失败profile。若新增ABI，要成组回退声明、bridge、DLL及相关产物，不混用旧组件。

## 实际状态

测试只读审查完成，详细证据保存在 `tmp/overlay-investigation/test-audit/TEST_REVIEW_WINDOWS.md`。未发现能解释当前失败的 fixture、隔离、就绪、节流、后置断言或结果分类错误。旧tmp探针要求完整全桌面链导致取证不足，已在新的隔离探针改为精确类枚举；正式测试与产品判定不受该限制影响。

设置查询不是完全无副作用：refresh无条件同步JS blurConfig与截图主题；只有resolved值变化才重新应用Window/Blur/Dock。原序列await每个操作后查询，尚无该changed分支参与失败的证据。对照会记录settings广播已观测revision与每次查询返回revision，避免把正常持久化版本增长误判为查询重排。

第一轮预先限定三次串行：原脚本无探针一次、原序列新探针一次、实际标题栏DOM菜单入口一次。其余snapshot/初始状态变体仅在新证据要求时执行。菜单通过真正Vue handler，使用原IPC观察值与错误做断言；DOM click不代表物理输入。三个attempt独立保留，禁止失败重跑到绿。当前没有新增原生修复或ABI变更。

## 第三阶段实际选择：先补主进程失败取证

三次对照均exit0/completed=true/52断言；两个探针各28样本，无probe错误、无源/产物漂移。API与菜单均在glass开启的top请求约48ms内完成；请求中相同band，Overlay前未观察到可见相交夹层。各步快照的已知beforeRevision与returnedRevision一致，未进入配置重应用分支。原失败仍存在于历史记录，没有复现根因，不执行额外snapshot/初始状态变体。

首次新driver被来源门禁挡在Electron启动前：当前会话环境digest不同，但source/dependencies/output/toolchain/ABI闭包逐项一致。三次只作为诊断执行，保留原proof，不伪造registry reuse accepted。来源阻断attempt亦保留。

目前优先补窄JS日志，不改native语义/导出，因而不升级ABI或重建DLL。文件范围为 `src/main/bridge/window-layer-diagnostics.js`（新增）、`src/main/windows/z-order-runtime.js`、直接行为测试、资产映射与本指导/索引/实施汇总。

实施步骤：

1. 新增惰性Win32读取器和可注入的纯采样函数。精确枚举BlurOverlayWindow最多64，要求唯一同PID匹配；父窗口到Overlay最多256步，检测循环；仅保留前8个窗口和首个阻挡者的固定字段。读取PID/TID/class/owner/topmost/visible/iconic/cloaked/rect及前后关系，不读取标题、正文或进程路径，不使用任何setter。
2. 保留多匹配、句柄失效、顺序变化和采样异常的unknown语义；顺序链截断/循环且无独立失败证据时也为unknown。已确认的band不匹配或可见相交阻挡者可以独立解释false，不能笼统说所有截断都unknown。前后重读父/Overlay，标明非原子观察。cloaked/iconic只提供解释，不改变原IsWindowVisible规则。当前DLL没有队列ACK，日志明确不提供执行完成认证。
3. confirm保留 `[0,40,120,240]`、原重试次数、确认条件、错误与回退；保存这4次已执行检查的时间/延迟/耗时/布尔值，纳入原 `window.z-order-confirm`。仅最终不收敛时、回退之前采一次层级快照，另写 `window.z-order-layers`，使用lastCheckedAt关联；拆分记录以符合既有8KiB/256节点预算。成功路径不采HWND链，不加定时器或额外等待。
4. 采样完整try/catch，失败不得替代原产品错误。用模拟读取器核验band、实际夹层、不可见窗口、cloaked、缺失/重复Overlay、截断/循环和异常；用受控confirm失败核验四次记录、持久化未写、实际回退及采样错误不替代产品错误。
5. 执行指定unit/严格lint/格式，必要app构建，然后一次原native-leaf真实专项。再用独立故障注入诊断验证真实失败日志（与自然故障分开，不能用于宣称根因或修复）。所有局部结果与旧失败分别保留；不跑全量矩阵。

停止/回退：仅补日志且局部通过时交付取证能力，原生问题保持未解决。下一次自然失败以该日志区分实际band/夹层与观察漂移；若仍不够再按前述ABI成组步骤加native队列/SetWindowPos日志。恢复z-order-runtime与manifest从本阶段before，删除本批新增文件必须先确认其本批归属；app输出重新构建，不混用陈旧out。保留S7、Windows-only、用户dirty和历史证据。

## 本阶段实际交付与结果

| 类型 | 文件/结果 | 状态与边界 |
|---|---|---|
| 测试审查 | `tmp/overlay-investigation/test-audit/TEST_REVIEW_WINDOWS.md` | profile/seed/ready/节流/await/断言/report完整核对；未发现当前误报依据 |
| 原生源码审查 | 同目录 `NATIVE_SOURCE_REVIEW.md` | 两次SetWindowPos、无owner Overlay、两套队列、STA与getter复核；无ACK，不能确证死锁或cloaked误判 |
| 日志独立审查 | 同目录 `LOGGING_REVIEW.md` | 无业务判定回归；预算意见补测完成；观察边界保留 |
| 新读取器 | `src/main/bridge/window-layer-diagnostics.js` | 仅失败时惰性加载user32/dwmapi；只读、无setter；首次/末尾状态、band/夹层/漂移/异常分类 |
| 窗口owner | `src/main/windows/z-order-runtime.js` | 4次检查历史与失败一次采样；原条件/等待/重发/持久化/异常/回退不变 |
| 测试与映射 | `tests/window-layer-diagnostics.test.js`、`tests/native-leaf-runtime.test.js`、`scripts/test-manifest.cjs` | 新8case模拟观察；确认失败/正常与提前失败不采样、诊断错误不替代产品错误；归属C-007，真实leaf映射新增读取器 |
| 最终unit | `tmp/overlay-investigation/logging-unit-final-accepted.json` | 4指定文件37/37；包含真实窗口字段与完整encodeLogRecord预算验证；严格lint/格式通过 |
| 最终构建/真实专项 | `tmp/test-runs/2026-10-09T09-30-14-390Z-wzTGgJ` | app build accepted；不改正式leaf，completed=true/exit0/52断言/accepted=true；只代表此attempt |
| 故障注入 | `tmp/overlay-investigation/failure-log-attempt-caInIf` | 只将glass-on top期间的Blur_IsZOrderSynchronized四次返回强制false；保留exit1/completed=false/33，明确是受控失败，不是自然根因复现 |

故障注入的真实JSONL同时保留原错误、4次核验和第二条物理日志。快照parent/Overlay都topmost、pairStable=true、无可见相交夹层，耗时0.254ms；说明诊断能记录独立实际状态，而不是照抄被注入的getter。样例关键信息在真实日志编码后完整，预算用例同时覆盖完整窗口字段及8个链头；这不保证任意极端长字段绝不被日志系统截断。真实回退代码不变，受控unit核对回退后的window状态和未保存设置；本次故障注入没有宣称客户机器回退已认证。

来源门禁保留两次启动前阻断：`original-attempt-m4s9dW`为会话环境digest变化；`failure-log-attempt-zd1BoB`另有Vitest `node_modules/.vite/vitest/.../results.json`缓存变化。诊断driver逐项核对源、输出、真实工具链与非缓存依赖，只有环境及该准确缓存路径允许作诊断比对；不修改正式runner/proof或认证reuse。所有attempt独立，不重跑覆盖失败。早期日志结构版本的build/native-leaf也通过，最终验收以上述新attempt为准。

原正式失败 `07-39-50-892Z-hXq5tc` 仍exit1/accepted=false。旧探针和本轮三个成功对照均不取消它。未修改native源码/DLL/ABI、正式native-leaf脚本、Renderer UI或用户数据库；新增日志不等于修复旧问题。最终恢复核对与结果索引见 `tmp/overlay-investigation/closeout.json`。

## 下一次自然失败如何定位

1. 保留同次本地app JSONL中的 `window.z-order-confirm`、`window.z-order-layers` 和随后 `window.z-order-change`，核对mode、lastCheckedAt、采样at/finishedAt及四次布尔变化。采样是在最后检查之后；稍晚恢复不能反推此前误报。
2. 若band不同，核查STA band切换的请求/处理/SetWindowPos结果；若有夹层，核查PID/class/owner/visible/cloaked/iconic与相交rect；若Overlay不在后方，核查两次排层之间的外部重排。仅有candidate/cloaked属性不能直接改可见性predicate。
3. 若日志观察已同步、pair漂移或unknown，继续窄native诊断，按前述ABI成组门槛加入请求序号/处理时间/SetWindowPos立即错误与同次predicate原因。区分主进程读取时的瞬时状态、STA尚未处理、已处理后被第三方重排；当前不能用bottom controller的syncPending替代Blur ACK。
4. 如明确是合法测试ready/fixture错误才修测试；若是合法公共调用触发产品拒绝，保留该场景并修对应产品链。保留自然失败与修复后局部红绿，不能只延长等待或删除严格断言。

本阶段已完成测试审查、窄对照及必要日志准备，根因尚未确认。未运行全量unit/窗口矩阵/Qt全集、发布验证、打包/安装、客户机、多屏混合DPI、Explorer重启、物理睡眠或长期压力专项，未提交/推送/发布/部署。枚举次数有界不等于单次同步Win32 FFI有硬超时；该限制与非原子、无ACK一起保留。
