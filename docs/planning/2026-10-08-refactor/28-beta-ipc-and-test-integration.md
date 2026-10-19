# BR-01/02 内测接线与测试治理实施指导

日期：2026-10-10。状态：IPC迁移、七DB适配与对应四项GUI已有有效局部结果；静态资产登记已归并，后续测试治理窄修、固定候选和包验收仍在实施，不预填内测就绪。

## 范围和恢复

本批从 `tmp/beta-readiness/br01-before-20261010-142947-829`、`ipc-registrars-before-20261010-142853-379`、`db-adapters-before-20261010-143010-613` 和 `app-ipc-before-20261010-143643-992` 保存进入时文件及身份。只认本批增量，不恢复整个 dirty 工作区，不接触真实用户资料，不发布。

## IPC 整理

1. `register-logging-ipc.js` 拥有日志三个授权 handler 和导出互斥；入口继续拥有采集器/controller 生命周期。点击截止、冻结、文件 snapshot、对话框取消和 finally lease 释放保持原语义。
2. `register-remote-notice-ipc.js` 拥有本地通知四口和健康缓存读取；动态获取 coordinator，不因查询联网。保留 HTTPS 链接和异步失败处理。
3. `register-wallpaper-ipc.js` 只做七口 transport；完整存储/设置/补偿仍归 background coordinator。
4. 在原注册位置接线，退出幂等移除自有 handlers，部分注册失败只回滚已取得的 handlers。同步真实 preload、背景导航、日志 GUI 消费者和 manifest/domain 映射。

局部验收：三个 registrar unit、实际 app-ipc preload（remote 为内存真实 SQL，wallpaper 为明确受控 ports）、真实 app 背景导航及日志导出。仅前者不能证明真实壁纸文件存储；用 background/storage 专项补保护。

## 七个旧 DB 专项

保留全部原业务断言，增加 Electron ready、独立 profile、attempt token/mode、业务 completion、证据和 cleanup。backend 的内存/磁盘与 duration 磁盘独立标注，其余内存 SQL；同进程 serialize/reopen 不称应用重启。失败保留数据库并关闭已打开连接，不在 finally 删除失败现场。

已验证七项共341不同业务断言，证据 `tmp/test-runs/2026-10-10T06-32-46-622Z-sf5oKQ`。故意错误期望的隔离副本被拒绝，见 `tmp/beta-readiness/db-negative-result.json`。reminder 测试在00:00:30可复现fixture尚未到时误报，仅将fixture00:01改00:00，保留原30断言；最终单项见 `2026-10-10T06-39-11-171Z-MFYxn3`。生产提醒未改。

## 静态读取和测试真实性

按27及后续29/30底稿逐项补真实读取关系；不存在的 Mac 文件应由配置/目录负保护覆盖，不能登记为必需存在的 source。日期时区测试读取迁移后的真实 timeline 函数，保留固定时区/23和25小时 oracle。静态审查、运行成功和结果适配分别记录。

首次同时运行GUI构建与基础设施unit使两个共享目录检查误报；构建来源也拒绝了 Vitest 写入 `node_modules/.vite/vitest/.../results.json` 的漂移。保留 `tmp/test-runs/2026-10-10T06-41-50-632Z-dYUz60`，真实专项被阻断未运行。后续构建与写缓存unit串行，不能跳过来源校验或用编译exit0冒称专项成功。

## Windows-only 遗留分支收口

27发现 `window-motion/index.js` 的 ElectronPointMotionBackend 只在非Windows使用，`dock-edge.js` 及其unit无Windows消费者。先保存三文件和唯一消费者，删除整套备用实现/纯测试，在工厂用既有platform gate明确拒绝不支持平台；删除旧调用的screen参数，并同步source/domain映射。WindowsPhysicalMotionBackend 的完整类体应与入场字节相同，原生边缘监视器、坐标、运动、50ms barrier都不调整。

验证平台拒绝与Windows工厂接线、dock unit及真实dock专项；实际双屏、混合DPI和自然卡顿仍移交测试群。恢复只用本批对应文件，不覆盖先前窗口修复。

## 余项和完成条件

14个指定unit文件180例通过；三个registrar、Windows motion工厂、dock、日期、平台及实际受影响的登记/入口/CI消费者均纳入，见本批attempt。Qt复制隔离、基础设施报告一致性、日报导出和真实诊断开销见33、36、37、35，按自身改动执行后另记；不能用这里的旧局部结果认证后续文件。

真实GUI结果 `tmp/test-runs/2026-10-10T06-49-23-098Z-9FaXfH`：app-ipc 102、background-navigation 62、dock-runtime 46均accepted；logging-actions当时只完成18断言，日志弹窗被另一模态阻挡，身份/原因尚未确定，保留截图，不判定holiday/welcome或产品缺陷。

日志后两次 `06-53-56-142Z-ftsMzs`、`06-58-33-320Z-aLYBA3` 均79/79业务完成，但最终capturePage三秒超时，整项exit1/accepted=false。GPU invalid信息出现在收尾附近，不能只凭该行归因。测试增加visible/focus/renderer visibility诊断以及最终前台invalidate+两帧准备，未关闭GPU、未延长截图门槛、未弱化79断言；`2026-10-10T07-05-33-198Z-zMuxet`首次79/79、JSONL四文件/真实截图/正常quit/cleanup完整accepted。此轮准备前已focused=true，因此不能把前台焦点丢失当已确认根因；当前只能称这条测试呈现准备已有效运行一轮，后续复核仍保留原失败。

29—31完成61产品unit、57非Vitest、10基础设施的逐项静态审查；与27的62和独立七DB合并，原197未审项全部有处置依据，其中dock-edge因非Windows死分支删除，其余保护保留。新增4项与recent静态登记合并后，当前299资产/277test，277test均为静态reviewed-protection，registry校验errors=[]。这不是277项运行通过；未适配legacy仍由focused拒绝。归并记录 `tmp/beta-readiness/audit/static-registration-change.json`，对应本批恢复点 `governance-before-20261010`。

21组确认的间接生产consumer补入sourceDependencies。C-011仅日报，日志/性能使用C-013；CI descriptor的自身suite补固定oracle。manifest治理测试改用私有未审fixture，允许真实非负有限测量成本，不要求almanac永远未审或全表永远unmeasured；实际cost仍未测量，未填假0。修改后的基础设施局部验收待36实现稳定后串行执行。

template标签fixture的NaN误匹配已私有复证，改真实数值ID并补四组正反例，33个原expect保留；唯一focused28/28通过，见 `2026-10-10T07-15-37-733Z-5dZmrI`与29。快捷键测试群清单8/9已修为当前session-only开关契约。

BR-02静态审查已完成；本批新增测试修复仍逐项运行。BR-03主链/诊断、BR-04包内/隔离升级卸载、BR-05交付按32继续。未执行旧全量入口、固定候选综合验收、候选包安装/升级/卸载或客户环境验证；本阶段尚未整体完成。
