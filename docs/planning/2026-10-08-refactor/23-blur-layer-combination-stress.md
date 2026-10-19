# 毛玻璃双窗口：组合、重入与状态观测压力排查

## 问题与授权

用户指出偶发问题不能仅做少量正常路径：应逐组合多次尝试，观察Electron与Overlay是否同时改变层级，并区分实际失联、瞬时读取和核验误判。本阶段只做此功能的有限压力调查，不运行全量测试、不改排层规则或正式测试，不把旧失败的DLL false直接说成已确认物理失联。

沿用22的实际构建、原DLL/ABI及失败日志，所有新证据放在 `tmp/overlay-investigation/stress/`，独立profile/attempt。原定三轮冷启动串行，避免相互争抢真实桌面；一轮无请求内热采样，两轮有热采样。三轮均在操作完成后读取Win32状态，防止只看设置或Electron缓存标记。这里的独立指观察接口独立于DLL判定，采样仍在Electron主进程内，不是另一进程观察；第一轮也有操作前后观察，不能叫完全无观察对照。

## 固定组合与刁钻场景

每个独立profile先核对renderer显示与capture ready，禁用Dock边缘、远程访问，使用当前schema种子。

1. 核心组合：玻璃off/on各3轮。按 `normal→normal→top→top→bottom→bottom→top→normal→bottom→normal` 覆盖全部9种有向层级切换；玻璃on前先进入bottom，保留旧失败的历史前置条件。每次正常请求从前次完成后留550ms，记录IPC结果、实际WS_EX_TOPMOST、原生bottom anchor、Overlay band/visible/顺序、设置持久化。持久化直接从本测试profile的SQLite只读连接查询，不主动调用有条件重应用运行态的getSettingsSnapshot；产品Renderer自行发出的查询照常记录，未屏蔽。
2. 焦点扰动：仅创建本测试自己的相交窗口，在top请求附近按0/15/45ms切入焦点。记录实际handler overlap，不能把同批发起直接说成真正并发。
3. 夹层扰动：只将本测试的interloper HWND通过SetWindowPos放到主窗口之后，绝不直接改主窗口或Overlay，也不调用Blur_ReSyncOrder。0/15/45ms三种时序，观察自动排层与产品确认。此为明确的环境扰动，不能冒称自然失败。
4. 可见性中断：通过真实window-close IPC隐藏，在80ms或550ms通过真实托盘owner恢复。记录隐藏期间与回显状态；主动关闭打断请求的拒绝单列，不自动计作原置顶bug。
5. 跨通道竞争：top请求与毛玻璃关闭在0/15/45ms附近交错，分别记录实际IPC开始/结束及最后持久化值。不会修改getter或直接native配置。
6. 快速重入：同批发送top/normal/bottom，按500ms/in-flight契约区分accepted与throttled；被节流的目标不要求落地，不能算失败。

每profile至多约88次层级IPC，三profile约264次；代码/结果以实际记录为准。首次未被主动中断且未被节流的产品拒绝，或操作后持续物理失联，保存现场后停止新组合，改为该具体前缀的窄复现；读取器异常、句柄失效或来源漂移立即停止。每个请求观察有界，整体单profile上限180秒。所有首次失败保留，不反复重跑替换结果。

## 如何区分真实失联与读取问题

热观察只读真实user32/dwmapi；对原Blur_IsZOrderSynchronized返回false的调用，在不修改返回值的前提下立即记录独立物理状态与前后两次原getter读数。记录观察增加的耗时，承认它可能改变调度；用无热采样cohort对照。

- 稳定band不一致、可见相交夹层或Overlay确实不在后方：支持实际层级问题，但必须区分请求中正常过渡、最终拒绝、拒绝后回退和外部扰动后的自动修复。
- getter false而随后Win32状态正确或原getter立即变true：先分类为瞬态/观察不一致，不能凭稍晚成功认定getter误报。
- getter连续false、独立物理观察连续正确且句柄/PID/TID/首尾关系稳定：构成核验误判候选；当前缺native绑定句柄代次和同次内部reason，仍不能直接断言Win32读取错误。
- 夹层WS_VISIBLE=true但cloaked/iconic：是当前可见性predicate定义问题候选，非GetWindow读错的证明；本阶段只记录，不改predicate。
- 无唯一Overlay、遍历截断/循环且缺独立失败证据、句柄变化、Win32读取失败：unknown，不能标为同步成功。

关闭玻璃/隐藏窗口不要求隐藏Overlay保持可见邻接；恢复显示后再核对。保留目标主窗口实际style与Electron isAlwaysOnTop差异，窗口枚举发现的唯一同PID类匹配不等于原子证明Engine绑定代次。

## 验证与回退

使用固定Codex Node、过滤Volta，真实Electron首次沙箱外。先核对原构建源/输出/工具链与非缓存依赖；只允许会话环境及已知Vitest results缓存作为诊断比对差异，不认证正式reuse。before/after保存生产源、原测试、out及DLL哈希。

临时脚本语法、计划/实际次数和每次退出码均保留。三profile不同时运行；只关闭本测试创建的窗口，不关闭用户软件、不操作Explorer。未改生产代码时无需重建DLL/app，也不重跑无关unit。

本阶段只新增临时harness与指导/索引，恢复不涉及业务/数据库；旧closeout和失败证据不覆写。自然问题得到可复核证据后先收窄机制与修复配方，再决定具体修改；不能以延长等待、隐藏错误、弱化断言或强制Getter返回值代替修复。

## 实际结果

### 1. 首次失败后立即收窄

第一轮未到焦点/夹层/隐藏等受控扰动就自然失败。因此按预定停止条件，不再执行另外两轮完整88请求组合；改用相同失败前缀做两次独立冷启动观察。不是跑满矩阵后忽略失败，也没有用通过结果覆盖红结果。

三轮实际前缀相同：glass off下准备normal，再依次normal/top/top/bottom/bottom/top/normal/bottom/normal；进入bottom启用glass；normal→normal→top。每轮14次层级IPC、2次材质IPC。前三轮均有13次模式请求完成，第14次glass=true normal→top被产品confirm拒绝。

| attempt | 观察方式 | 业务结果 | 回退前物理证据 |
|---|---|---|---|
| `cold-control-p0cwIL` | 无请求内连续采样，保留前后读数和产品失败采样 | exit1、completed=false、132个前置/已完成步骤断言、14次mode | 四检查0/46/171/420ms均false；最终main topmost=true、Overlay=false、pairStable=true |
| `prefix-observed-1-6sIoYf` | 相同前缀＋getter false即刻观察＋25ms计划连续采样 | exit1、completed=false、132断言、14次mode | 四检查2/46/173/425ms均false；13个请求内快照均stable band mismatch；首次getter快照自身漂移归unknown |
| `prefix-observed-2-hx2njb` | 相同前缀＋上述观察＋原有reSync FFI进入/返回记录＋失败后只读等待 | exit1、completed=false、132断言、14次mode | 四检查2/46/168/419ms均false；最终stable band mismatch；拒绝后100/1000/3000ms的getter两侧仍false |

总计42次mode请求（39完成、3拒绝）、6次材质请求。每轮132个已执行断言均成功，失败发生于产品IPC拒绝，不能把396断言或assertions.failed=0写成整项通过。三轮都是诊断执行，未登记registry accepted。3/3是这个确定前缀在本机本时段的结果，不能当作整个产品或客户机器的故障率。

玻璃off的9种有向转换与重复选择已覆盖；玻璃on的完整矩阵、三个core重复轮、焦点抢占、主动夹层、隐藏/托盘恢复、跨通道交错和快速重入均没有执行。相同前缀已出现异常后没有继续扩张。无actor、无主动hide、单模式IPC、正常550ms准备间隔；没有强制getter false或直接修改main/Overlay层级。

### 2. 可确认与不能确认的事实

三次产品`window.z-order-layers`回退前记录都找到唯一同PID BlurOverlay，主窗与Overlay有效、可见、非iconic、cloaked=0、topmostKnown=true、几何一致；快照首尾相同。主窗已在topmost band，Overlay留在普通band。这支持实际层级未联动，不能解释为仅设置缓存错误、仅cloaked/iconic定义或getter与物理状态矛盾。

观察仍非原子，不提供native绑定句柄代次或消息ACK。全桌面链到256上限，不妨碍已直接读取的band差异证据，但不能认证完整夹层位置。第三轮回退后main退出topmost，两个窗口band相同；只读短链发现可见相交窗口先于Overlay被访问，原getter持续false，完整长链位置仍未核验。这里只能说当时未观测到自动恢复，不能推导永远不会恢复或用回退后normal状态解释原top失败。

第三轮原有`Blur_ReSyncOrder`确实被调用且快速返回：目标请求开始后至回退前5次，回退时2次，均小于0.1ms。证明main→FFI入口已经到达；void返回不等于PostMessage成功、STA已dispatch或SetWindowPos已完成。`healthy=true`也不能证明线程响应，Effect更新会重置healthy/lastError。

当前机制候选收窄为：STA消息未处理/被阻塞、pending去重状态未释放、排层调用失败或成功后被其他时序改回。直接bottom拦截不是当前最强候选：B→N和N→N都成功，最后top时bottom已disabled，SetBottom(false)按源码为noop。尚无原生队列/执行阶段证据，不把某个候选写成已确定根因。

完整证据见 `tmp/overlay-investigation/stress-evidence-analysis.json` 与各attempt的result、stress、standalone、process.log和独占profile JSONL；第一轮日志app:44/45是四次confirm和回退前band快照。独立审查见 `tmp/overlay-investigation/stress-harness-review.md`。

### 3. 下一步原生取证配方与修改门槛

下一步集中查这条失败前缀的消息生命周期，不先延长confirm、不弱化getter/邻接条件、不自动重复到绿。实施前保留native源码/DLL/out/bridge/ABI/相关测试恢复快照，沿用本次三个原始失败。

1. 在Engine内新增有界只读诊断状态，标记HWND/PID/TID和初始化代次；记录QueueZOrderSync请求序号、来源、pending旧值、实际post序号/成功与立即捕获的Win32错误。计数器和最后事件必须跨线程安全，不能为每个WinEvent同步写磁盘或保存用户窗口内容。
2. 记录WM_BLUR_SYNC_ZORDER取出、SyncZOrder开始/结束、当前处理序号及时间。区分“没有dispatch”“进入后卡在某阶段”“已结束但物理状态被改回”；healthy位不当作ACK。
3. 对band切换和最终SetWindowPos分别记录前后parent/Overlay band、调用BOOL、立即错误、可见性和当前阶段；失败返回也必须入诊断。用有界事件环保留最近历史，读取时标明是否跨序号/代次，不能把非原子快照当原子状态。
4. 原同步getter返回false时保留具体predicate reason：无效句柄、style不一致、读取失败、可见相交阻挡、Overlay不在后方；只补原因，保持原返回值和判定规则。若getter独立观察矛盾，再核对同代次/同句柄，而不是直接宣称user32获取错误。
5. 用一个有上限的只读native导出读取上述状态，由main失败日志消费。新增导出和诊断语义按仓库要求成组同步ABI到下一版本（当前18）、header/impl、shared ABI、bridge、manifest/相关测试，重建DLL和app并核对构建来源；Renderer无需新增状态显示。
6. 先做对应getter/ABI/日志预算的局部验证及必要native/app构建；只运行这个14请求前缀的真实Windows专项。记录首attempt原退出码和物理状态；不要默认跑全窗口矩阵或全量unit。
7. 根据新证据选择修复：post失败处理、pending代次/消费交接、STA阻塞源、SetWindowPos错误或其他owner重排分别有不同配方。先记录确定触发条件，再写最小修复和保护该失败行为的测试；mock的counter正确不能替代两个真实HWND的结果。

本阶段只完成组合调查和下一步取证指导，未修改生产源码、正式测试、DLL/ABI或out。三轮before/after共核对873路径，运行中无变化；最终按首轮保护范围再次核对，具体见本阶段closeout。临时脚本已做固定Node语法检查；不重复无新修改的旧unit。未运行全量、客户机、多屏/DPI、Explorer重启、物理输入/睡眠、长期压力、安装或发布验证。
