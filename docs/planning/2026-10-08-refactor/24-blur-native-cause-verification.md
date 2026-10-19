# 毛玻璃置顶：可重复原生机制验证

用户明确要求持续反复测试，直到原因可被反复验证。沿用23的三个原始自然失败，不覆写或以新通过结果取消。此阶段只调查同一Windows主窗口/Overlay同步，采用局部测试与必要native/app构建，不默认全量。

## 验证目标与方法

必须得到实际失败发生在哪个native阶段的证据，再用只改变该机制的对照重复：原路径失败、控制变量改变后正确、恢复原变量再次失败。仅一次绿色、不同源码/环境的结果或设置标签正确都不足以认定原因。每次使用独立profile和attempt，保留所有退出码、失败、时序、源码/DLL版本及实际Win32状态。

首轮新增opt-in native trace（ABANDON_NATIVE_Z_ORDER_TRACE=1），记录Queue请求/post/dedup、STA GetMessage前后、WinEvent进入/返回、sync dispatch/开始/结束、两次SetWindowPos进入/返回及错误、predicate遍历进度。固定256项环与total/dropped，读取不调用setter、不修改原getter结果、不改变确认等待或节流。诊断默认关闭；新增只读导出成组同步ABI18→19、bridge、manifest与正式专项metadata，重建DLL/app。

恢复快照：`tmp/overlay-investigation/native-cause-before/inventory.json`。改动范围为native engine/API、共享ABI、bridge导出绑定、manifest ABI前置描述、两个已有专项metadata；临时观察器读新增导出。Renderer不涉及，现有用户数据不操作。

## 假设与最小对照

1. 若normal→normal前pending已true、post存在但dispatch不增长，先区分整体STA阻塞和posted queue饥饿。配置的同步SendMessage可先于posted处理，所以配置/B→N成功不作为消息泵ACK。必要时用无setter的sent/posted heartbeat对照。
2. 若WinEvent enter无exit，记录具体callback/predicate/访问数；若callback持续占用而posted无进展，只改变reorder hook自进程事件参与或暂禁reorder，保留显式ReSync与其他正常路径，再还原对照。未有此证据前不直接归因事件风暴。
3. 若某个setter enter无return，先定位该线程与目标。仅对已定位的跨线程路径做对应变量控制；真实HWND收敛必查，异步API返回不等于成功。需要时采该线程栈/等待链，不能凭不同TID认定死锁。
4. 若Sync已经正确完成后被改回，记录具体后续setter/WinEvent；只改变已定位的来源。若两个BOOL成功后仍不同band，核对调用参数、实际Win32效果与读时序。
5. 对底部历史是否必要、重复normal请求是否必要，采用fresh normal→glass→normal→top与相同等待替换第二normal等序列控制；同时间/相同版本，不将省略准备失败计作目标覆盖。

## 执行与修改门槛

先做ABI/manifest/运行门禁直接相关unit及native构建，再用正式局部runner生成app构建来源并执行native-leaf。保留自然失败；临时前缀实验只作为诊断，不伪签registry accepted。每次查看trace后选择下一个变量，不机械重复到绿。

找到机制后先写清最小触发条件、原生阶段与A/B恢复证据，再决定必要修复和保护测试。不能强制清pending、延长timeout、弱化predicate或隐藏错误来制造成功。最终补同域玻璃on/off正反切换、重复选择与恢复验证，明确全量/客户机/多屏/安装等未覆盖范围。

## 实际记录

两项独立机制已通过同DLL/app单变量恢复对照验证，窄修复、扩展组合与正式保护测试已完成本机局部收口。以下保留每阶段当时的结论，新的证据不能取消原始失败；局部收口不等于全量或客户环境验收。

### 恢复原版本的对照

trace19恢复点保存于`tmp/overlay-investigation/native-cause-trace-checkpoint`，包括10个对应产品文件、out和构建proofs。临时恢复ABI18原源码、桥接、manifest、专项metadata以及原DLL，并通过正式局部runner重建匹配app。原DLL两轮前缀均通过：`prefix-native-old18-1-7D4VEe`、`prefix-native-old18-2-3kpobR`。之后进一步恢复三个原版临时脚本，`prefix-observed-2-cXYtNs`仍通过。除前三轮临时脚本差异外，源码、out、native、tests/scripts的哈希与原失败轮一致；恢复脚本后的通过也不能撤销原三个失败。

隔离复制原native源码重编译ABI18 DLL，原DLL和新DLL的执行代码、数据、资源、重定位逐字节一致，只有COFF/debug两个时间戳共6字节不同。证据`tmp/overlay-investigation/pe-original18-rebuild-comparison.json`。因此没有证据支持实质源码/DLL不匹配或编译修复，不采用“重建后通过”结论。

### 独立发现：成功返回后的夹层自愈缺口

旧18原版全组合`cold-control-fsSyjb`在第75个mode请求的`interpose-45ms`失败，813/814已执行断言通过，completed=false。top IPC先成功；受控测试窗口在之后插入parent与Overlay之间；实际完整链main→owned blocker→hidden IME→Overlay，两窗同topmost=true，100ms后仍有夹层。它独立于最初的错band/IPC拒绝，不能互相替代根因。

trace19两轮`cold-control-Ob84eR`与`cold-control-8fARCc`复现同一场景。对应pending=false、posts=dispatches、syncStarts=syncEnds，没有未执行的同步请求。新增只读回调参数后，后者捕获夹层出现附近的3个EVENT_OBJECT_REORDER：HWND=0x1000c、objectId=-4(OBJID_CLIENT)、childId=0，全部被OBJID_WINDOW-only条件过滤。独立Win32读取确认GetDesktopWindow=0x1000c。每分钟健康诊断可能另行修复，100ms无自愈不等于永久失联。

下一实验使用同一ABI20 DLL/同一app：只接受desktop HWND的CLIENT/SELF事件，其它CLIENT事件继续过滤；trace+owned integration下`ABANDON_NATIVE_DESKTOP_REORDER_TEST=0`恢复旧条件作为A，缺省或1作为B。记录开关于native快照与driver环境差异；A/B/A/B必须分别保留失败或完成，不能弱化Win32判定。ABI20同步shared/API、manifest与两个专项metadata。最初自然错band仍需要独立机制证据。

一次恢复19时最新proof仍是18，driver按closure正确拒绝（`cold-control-u856im`），没有运行业务。随后重建匹配19app再运行，不把门禁拒绝计为代码失败。WCT辅助读取发生在进程退出后，两次windows/chains为空，没有线程阻塞证据；后续若使用必须在活着的owned进程中采样。

### 自然错band的原生阶段与重复恢复对照

ABI20正式native-leaf在`tmp/test-runs/2026-10-09T14-34-25-751Z-fl30YL`再次失败（completed=false，33条已执行断言不能算专项通过）。随后`prefix-native-oldfilter20-1-24Gtii`、`prefix-native-windowpos-a1-ggaVOY`、`prefix-native-setter-control7-XoI1u1`及`prefix-native-setter-control10-jriPyb`等自然前缀重现第14次glass-on normal→top拒绝。posts/dispatch及sync进入/退出持续配对，pending=false；STA的SetWindowPos返回BOOL1后新读Overlay仍false、parent=true，重试相同。证明这些样本的失败发生于真实层级设置效果，没有消息未处理证据。成功分支trace中的error=0是合成诊断值，不代表API成功后的原始LastError为0。

`prefix-native-reset-info11-5tv1qP`增加独立GetWindowInfo（WINDOWINFO size60，dwExStyle offset40）与GetWindowLongPtrW核对；两者都确认Overlay未置顶，后续100/1000/3000ms仍不收敛。它们都是非原子Win32读取，不是独立内核oracle，但与原getter、身份/可见性/几何和稳定前后状态共同排除了该样本只有测试getter误读的解释。

故障回退后main已normal，仅对本attempt PID的Overlay直接调用TOPMOST以及NOSENDCHANGING都返回1但无效果；NOTOPMOST→TOPMOST后Overlay置顶。`prefix-native-reset-public12-YCo56b`进一步通过公开IPC确认pair恢复为top且getter=true；同一window随后bottom→normal→top再次拒绝。不能将只恢复Overlay一窗当成双窗已正确，所有控制均保留原始失败exit1/completed=false。

为排除等待/调用次数混杂，`prefix-native-matched2-Xuasvm`与`prefix-native-matched-ime3-02WwND`在自然失败/回退后的同一HWND、main线程、flags0x13、相同调用次数和各100ms等待，分别完成三轮A/B：A=TOPMOST→TOPMOST，public top 6/6拒绝；B=NOTOPMOST→TOPMOST，public top 6/6成功且Win32 pair、原getter与持久化一致；B后bottom→normal→top 6/6再次拒绝。两attempt DLL SHA相同，运行期间源码/DLL/out无变化。精简证据`tmp/overlay-investigation/matched-cause-evidence.json`。该结果证明reset的路径作用及bottom历史可重新引入故障，尚不能命名Windows内部缓存损坏。

完整IME观测进一步显示：Overlay默认IME HWND由本Overlay线程创建、owner=Overlay；正常top时两者均top且IME紧贴owner。bottom后IME和Overlay均false但IME远离owner；再次TOPMOST时IME变true，而Overlay仍false留在桌面锚点。normal回退后IME仍true；显式NOTOPMOST使IME/Overlay重新成组且都false，后续TOPMOST才一起true。当前进程有WeType模块的存在不构成第三方致因证据，不操作或关闭用户输入法进程。即时前驱为活着的其它进程CEF-OSC-WIDGET，不能沿用事后失效HWND推导过期锚点根因。

### 下一单变量：非交互Overlay线程的默认IME

候选ABI21在STA入口、COM/DispatcherQueue/任何窗口创建之前调用ImmDisableIME(GetCurrentThreadId())，仅涉及这条绘制背景、不承担文本输入的线程。主窗口、Renderer、用户输入法设置及其它线程不改变；记录该BOOL与后续ImmGetDefaultIMEWnd，不能把环境变量开启当作实际禁用成功。链接imm32，同步API/shared ABI、manifest及native-leaf/dock metadata。精确恢复点`tmp/overlay-investigation/native-cause20-checkpoint/inventory.json`（62项，含source/DLL/out/proofs）。

只在trace+owned integration下允许`ABANDON_NATIVE_OVERLAY_IME_TEST=0`恢复旧IME行为A；1或缺省为候选B。对照期间desktop reorder固定0，reset控制关闭，使用同DLL/app、相同14请求前缀、独立profile做A/B/A/B；每A必须捕获原型自然拒绝，每B至少三次完成且BOOL1/defaultIME HWND0。`run-ime-abab.cjs`保留每轮exit、原始profile及环境差异，不将临时诊断伪签为registry accepted。后续再独立验证desktop过滤及完整同域组合，避免两变量混杂。

当前21必要native build成功；四指定unit（ABI门禁、manifest、打包配置、窗口只读诊断）63/63通过；必要app build及native-leaf在`tmp/test-runs/2026-10-09T15-21-34-041Z-GocAg8`正式accepted。A/B/A/B与独立Win32最小复现仍在执行，不能以该单次专项通过结案。第一次误用build=fresh被参数解析在启动前拒绝，随后按规定rebuild；前者不计代码失败或有效业务测试。

### IME 单变量对照完成

`tmp/overlay-investigation/ime-abab-NaoRtz/result.json`保留完整A/B/A/B。desktop过滤固定旧行为0，reset控制关闭，14请求前缀、独立profile、相同DLL/app。DLL SHA256为`205cf7f9fbdcf70b6b165ec0bb94e5abfc3fe2b39e98ce722a5b7df9ba87a3ac`。

| 阶段 | 默认IME行为 | 结果 |
| --- | --- | --- |
| A1 | 原行为，未禁用 | `prefix-native-ime-a1-1-ejmQeh`第14请求自然拒绝，exit1/completed=false |
| B1 | 仅禁用Overlay STA的IME | `rBIECO`、`pntTth`、`eJcrDJ`三次各14请求完成，exit0 |
| A2 | 恢复原行为 | `prefix-native-ime-a2-1-hLNWG6`第14请求再次同型拒绝，exit1/completed=false |
| B2 | 再禁用Overlay STA的IME | `MwHu5X`、`GzJNk8`、`h7BaFi`三次各14请求完成，exit0 |

六次B实际`ImmDisableIME`返回1且默认IME HWND=0；不是只检查环境开关。A的原生setter返回1后Overlay仍non-topmost、主窗口topmost，两个独立API与原getter一致。该证据确定本机产品故障依赖Overlay STA默认IME参与的窗口组排层路径；未定位Windows私有内部算法，不能称“缓存损坏”或命名WeType为根因。正式修复只在背景绘制线程创建任何窗口前禁用其默认IME，不禁用主线程、Renderer文本输入或用户系统输入法。没有添加生产band reset兜底，也没有改变产品确认等待、节流或getter。

### desktop重排过滤对照完成

`tmp/overlay-investigation/desktop-abab-M1CCGq/result.json`独立固定IME禁用，只改变desktop CLIENT/SELF过滤。A1=`desktop-native-a1-proof-1-EIQCa0`与A2=`desktop-native-a2-proof-1-FYnBDC`均捕获本attempt可见相交测试窗口夹在两窗之间，两窗同band且pairStable=true，100ms仍未恢复，raw/driver exit1。B1=`desktop-native-b1-proof-1-8GVaqz`与B2=`desktop-native-b2-proof-1-UgnKv3`各三次插入均恢复，各90/90、raw/driver exit0。

修复精确接受`EVENT_OBJECT_REORDER / GetDesktopWindow() / OBJID_CLIENT / CHILDID_SELF`，保留其他CLIENT过滤和已有相邻检查/去重队列。必须继续区分错band拒绝与成功返回后夹层，二者各有独立对照。

### 独立Win32程序的支持证据与边界

临时工具`tmp/overlay-investigation/win32-band-repro`没有Electron、产品DLL、WinRT或产品WinEvent hooks。恢复版记录`recovery-evidence-7b0b151b4815412ba8ed78064d1c3a33`：A1五轮无失配、父恢复一次也未执行；B1五轮无失配；A2五轮中四轮失配；B2五轮无失配。A2第68行确认父fallback后两API均topmost；第73行Overlay STA setter BOOL1但Overlay两API均false、其默认IME均true；第74行等待后仍false，最终第184行记录四次父恢复且零次父恢复失败。

A1未复现必须保留，不能把此工具说成严格ABAB全部成功。A1底部后同样出现IME仍top/离owner但后续成功，说明这些读数不是失败的充分条件。工具setter间距含快照写盘/Pump约124–126ms，产品父fallback及band→adjacency无该等待，样式和生命周期也不同。独立程序支持同机Win32层可以出现同型失配；产品单变量因果结论以真实app ABAB为准。

### 测试退出码缺陷

`desktop-native-a1-Qh7dxs`曾completed=false且业务断言失败、raw exit0，原记录保留且从未计为通过。临时脚本只设置局部exitCode，而产品logger最终退出屏障读取`process.exitCode`。修正临时脚本及正式native-leaf的启动、业务失败、watchdog/cleanup退出路径，driver同时要求raw exit0、standalone.completed、stress.completed与failed=0。后续ABAB raw与driver退出码一致。正式runner此前已经拒绝completed=false，不能宣称它将这个失败误判为通过。

### 隐藏/托盘恢复：过早断言的重复验证

生产默认、trace关闭的完整组合`cold-control-LriRwJ`在第77请求失败，842/843已执行断言通过，completed=false，不能计专项通过。保存源码第96行是Overlay.visible断言，第95行healthy已通过；不是健康失效。15:47:57.788主show，.789观察两窗top=true、pairStable/adjacency/native before+after=true但Overlay隐藏；.790断言失败；.798产品deferred restore结束，.799才启动退出清理。

`openMainWindowFromTray()`只等待presentation退出后调用show；show通过`createDeferredWindowRestore`的`setImmediate`恢复毛玻璃，返回不保证该恢复已执行。不得为了测试改成show消息栈内同步恢复。新增临时restore-only诊断，原即时断言保持失败，再只读取即时、名义5/15/45/100/1000ms状态。独立冷启动`cold-control-9Iq8jC`、`cold-control-MhTI1Y`、`cold-control-m6nDO7`三次都在即时失败，首次被动样本实际约5–11ms已显示；后续健康/band/相邻/显示均正确。没有focus/setMode/resync、没有重建Overlay。这确认该观察点误判了正常延迟恢复。

仅对确实隐藏后show的场景修正oracle：保留原即时隐藏读数，使用该场景原有100ms只读预算核对恢复；正常mode IPC仍按原确认契约即时验证。不能全局增加15秒宽松轮询。新的`cold-control-4rP067`、`cold-control-O0rqB5`、`cold-control-aphgDw`三次各两种隐藏时间80/550ms，均71/71完成。

负对照`cold-control-v2x2Fy`在产品恢复完成后只隐藏本attempt PID的Overlay，保持健康true、band一致和相邻。新oracle在100ms读数仍正确判失败（28/29、raw/driver exit1、completed=false），被动到1000ms仍隐藏。说明修正未把真正的持续隐藏漏掉。此负对照只存在临时测试，不加入产品。

### 正式保护范围与后续收口门槛

正式native-leaf已覆盖玻璃off/on的完整有向mode序列、重复选择、启用前bottom历史、真实Win32状态以及三次成功IPC后的owned blocker插入；记录默认IME HWND作证据，不用它替代用户可见行为。`tmp/test-runs/2026-10-09T15-43-25-665Z-LqyYoF`中build-app、dock(38/38)与native-leaf(268/268)正式accepted。该版本native-leaf尚不包含隐藏/托盘恢复，dock种子blur=false，二者不能声称覆盖了上述恢复问题。

收口前必须补正式恢复保护：glass off/on × normal/top/bottom × 80/550ms隐藏后托盘恢复；保留show返回即时样本，经过一次setImmediate边界，再于固定100ms只读观察，核对身份/PID/可见性/目标band/相邻/健康/配置及持久化。新增专项应沿用runner的raw/process/business/evidence/cleanup共同验收。再跑生产默认、trace关闭、所有控制setter关闭的完整同域组合连续三轮；任一新失败停止扩展，保留失败重新定位。

### 最终局部复验（2026-10-10，已完成）

完整同域组合连续三次独立profile全部完成：`cold-control-KoD2eQ`、`cold-control-LgdQiR`、`cold-control-g9dUNA`。每次88次mode请求、14次material请求、18场景、995/995断言、raw/driver exit0、completed=true、anomalies=0、nativeGetterFalse=0、changed=[]；合计264次mode、42次material、54场景、2985条已执行断言。trace关闭，IME与desktop用生产缺省，setter/reset/负注入均关闭。精简汇总`tmp/overlay-investigation/production-default-three-combinations.json`，临时诊断仍registryAccepted=false，不能改称正式runner验收。

已补正式native-leaf上述12个恢复组合，show即时/事件循环边界/100ms读数全部留存；主/Overlay身份、PID、隐藏与显示、band、相邻、cloaking、健康、底部锚定、renderer设置与只读SQLite持久化分别断言。`tests/native-leaf-runtime-electron.mjs`没有补发恢复性setter或focus。新增前脚本保存在`tmp/overlay-investigation/native-leaf-before-restore-cases.mjs`。

正式`tmp/test-runs/2026-10-09T16-04-50-078Z-f7QOkX`：必要build-app accepted、dock 38/38 accepted、增强native-leaf 598/598 accepted。第二独立启动`tmp/test-runs/2026-10-09T16-07-47-303Z-Logca1`与第三独立启动`tmp/test-runs/2026-10-09T16-09-43-479Z-cy9uxv`均必要build-app与native-leaf 598/598 accepted，raw exit0、completed=true、失败断言0。新增恢复组合共36次，完整native-leaf合计1794条已执行断言；三个正式runner均successful=true、legacyUnproven/unverified/failed/blocked=0。补测试后再重建app，489个src/native/out文件哈希与第三次完整组合全部一致，故这些通过对应同一产品实现，而测试范围增加不冒充产品再次改动。

本次最终native复审没有发现阻止局部收口的新业务问题。诊断读数须按以下约束解释：`overlayImeDisabled`是策略，应结合returned与真实IME HWND；`error`字段按stage复用，WINDOWPOS表示flags、WinEvent arguments表示childId、成功setter的0是合成值；ring与counters跨Initialize累计，只有header generation，不能将所有rows归入当前代次。trace off仍有少量原子计数/phase写入，不能宣称是ABI18逐字节原版。读取非原子，不称内核oracle。

未执行全量回归、安装/发布、用户电脑、多屏/混合DPI、Explorer重启、睡眠唤醒或长期压力，未做人工输入法候选输入及逐像素毛玻璃外观验证。局部因果证据和本机复验已足以支持两处窄修复；不能承诺所有Windows/input-method环境无任何故障。

### 实施清单与复验入口

本故障相对ABI18恢复点的产品/正式测试增量集中于10个文件：native engine/API的4个cpp/h、native CMake、shared ABI、blur bridge、manifest及native-leaf/dock两个专项。不要把工作区中其它重构、macOS清理、Renderer或未提交修改归入本故障改动。旧18/19/20恢复点、各原始失败、控制对照、原测试脚本均保留，不reset/clean。

1. 原生Overlay STA最开始禁用当前线程IME，链接imm32；不得改成全进程或其它线程禁用。检查实际BOOL与默认IME HWND。
2. WinEvent只额外接受desktop CLIENT/SELF，沿用可见性、band/相邻与去重逻辑；不得放开所有CLIENT事件或强制频繁重排。
3. 保留只读opt-in诊断和固定256项ring；getter、用户节流、确认等待与排层顺序不放宽。native导出/语义版本从18按实验阶段递增至21，API/shared/manifest/专项metadata及DLL一致；重建native与app。
4. 正式native-leaf保留完整有向切换、重复选择、启用前bottom、成功返回后夹层三次和12种恢复组合。普通mode IPC即时核验；show返回只先留原样本，再跨事件循环观察，并保留100ms末读数。失败退出必须同时设置process.exitCode。
5. 局部验证入口：四个指定Vitest文件`native-runtime-gate.test.js`、`test-manifest.test.js`、`package-native-config.test.js`、`window-layer-diagnostics.test.js`；真实窗口用`scripts/run-focused-tests.cjs --file tests/native-leaf-runtime-electron.mjs --file tests/dock-runtime-electron.mjs --build rebuild`。本次四unit 63/63、native build、对应app builds、五个本批JS文件严格ESLint、增强native-leaf Prettier及选定文件diff检查通过。
6. 若再出现同型失败，保留独立profile、进程退出与completed、DLL/source/out哈希、原getter、两API、HWND身份、可见性、完整窗口链与trace阶段；再选单变量，不用稍晚绿色撤销失败。输入法A开关与desktop旧过滤只在trace+owned integration允许，临时driver不签正式accepted。

以上Node入口统一显式使用仓库AGENTS指定的缓存node.exe并去除PATH中Volta；真实窗口在适合桌面/缓存访问的环境执行。这里的三轮完整组合属于本故障的局部组合，不是全项目回归。最后证据索引为`tmp/overlay-investigation/native-cause-final-closeout.json`，旧closeout文件保持原样。
