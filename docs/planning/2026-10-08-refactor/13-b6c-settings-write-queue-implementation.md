# B6c 设置写入队列实施指导

日期：2026-10-09。范围：SettingsPanel 中普通 setting、blur、auto-start、dock 四类写任务的完整生命周期。状态：队列、局部异步/Vue watcher 与 B6c/B6d/Q001 联合真实应用专项已验收。

## 改动前证据与修改边界

恢复目录 `tmp/refactor-baselines/B6c-2026-10-09T01-26-00/` 保存原面板、局部保护和两个真实交互专项的原件与 SHA-256。`reproduce-existing-races.cjs` 从该原件提取未经改写的生产 syncBlurConfig、onDragEnd 和 reset 函数，配合可控 Promise 得到 `baseline-race-reproduction.json`：两个 blur 请求反向返回后，最终用户意图 false 被旧结果改成 true；reset 进入后 drag-end 发出的尺寸写入不在四个在途集合里，reset 在其完成之前执行。

这是生产函数的控制依赖复现，证明上述代码路径的排序缺陷，不宣称真实原生引擎或客户机器已经出现同一现象。本批修正这两条已复现路径；Q001 跨 scope 原子性由后端当前拥有者独立真实 SQLite 复现和修复，不把队列改成万能重试，也不改变业务 schema。

## 唯一所有者与迁移顺序

新增 `composables/useSettingsWriteQueue.js`，唯一持有四类 inFlight、普通设置 Map/timer、blur timer/启用反馈、auto-start/dock/blur 的请求代次、初始化/回填 gate、reset 与 dispose barrier。面板保留颜色/CSS 预览、值 refs、动画/拖动/焦点和展示状态；通过 api、真实表单 refs、dock.assign、snapshot.assign/fallback 和消息/诊断口连接队列，不复制配置或读取第二份可写配置。

| 写域         | 入队/提交                                                                    | 回填与失败                                                                                       | 生命周期                                                       |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 普通 setting | 离散选项立即写；连续值按 id 300 ms 合并，保留最后值；panel drag-end 也走此口 | 保留请求/排队诊断；错误不毒化下一写入                                                            | close 排空；reset 丢弃未发任务、等待已发任务；卸载先发送最后值 |
| blur         | 150 ms 防抖；新的用户意图入队即作废旧响应                                    | 只允许当前代次反馈；失败回拨在 nextTick watcher gate 内，不再重复提交；保留原错误码/启用失败文案 | 跟踪结果处理完整链；reset/dispose 作废旧 UI 反馈               |
| auto-start   | 实际 OS set/verify，保持不写 app_settings                                    | 只允许当前代次反馈；回读赋值不产生第二次 OS 写                                                   | reset 等待写入及失败回读；卸载后结果不改 UI                    |
| dock         | 收到表单规范化后的完整 DTO，立即提交                                         | 只回填最新代次；失败读权威快照，再显示既有失败反馈                                               | reset/close 等待完整回读链；运行时广播在本域无在途任务时回填   |

四类 tracking 记录完整异步处理链，包含失败后的权威回读和 nextTick 抑制，不只记录原始 IPC Promise。waitForInFlightWrites 循环等候各集合排空；已成功完成的链释放自己，不保留失效缓存。

load 先关 gate、取消尚未发出的普通/blur任务并作废旧代次，随后赋权威 snapshot 或既有 fallback；nextTick 后恢复 gate。并发旧 load 和卸载后的 load 不得赋值。运行时 blur 回填通过 withoutWrite，仍保持主进程的 wallpaper 过渡快照不能抢先关闭正在请求的 blur。

reset 的固定顺序：进入 isResetting → 关闭所有 gate/作废代次 → onDragEnd（此时新尺寸写入被阻断）→ 丢弃未发修改 → 等待四类完整链 → 调用 resetSettings → 权威 snapshot 回填 → nextTick → 恢复 gate。失败保留错误、重新读取实际状态，允许下一次用户操作；不声称 reset 成功，不自动重试，也不把部分状态回填成默认值掩盖后端失败。

dispose 在关闭 gate 前发送最后 pending intent，然后作废所有响应并停止自己持有的 watcher/timer。写入可以完成，旧页面不再弹消息或被结果回拨。面板统一调用 queue.flush/queue.dispose，不再维护同类集合或 gate。

## 已运行与待补验证

`settings-write-queue.test.js` 的 12 个用例全部通过，使用 Vue 实际 ref/watch/nextTick、独立可控 Promise 和 fake timers：初始化不写回、同 id 合并、普通失败后再写、blur 新意图尚待防抖时拒绝旧结果、启用失败回拨无重复写、auto-start 反向结果/OS 回读、dock 过期结果/失败回读、四域 reset 排空与尺寸 gate、reset 失败回读与重试、强制卸载最终值保存与迟到反馈抑制、过期 load/dispose。

八个既有消费文件共 61 用例首轮 60 通过；唯一失败是其他代理主入口迁移后的 view-visibility-shortcut-ui fixture 未传 getMainWindow，由当前主入口拥有者处理。本面板控制及源码边界保护通过；保留该失败记录，未自行改动其 owner 文件。B6d 后对 queue/dock/density 联合复跑，队列 12 例仍通过。四个本域文件最初 ESLint 无错误，最终本域十文件 lint 已退出 0。

证据：`queue-unit-results.json`、`consumer-unit-results.json` 位于 B6c 恢复目录。B6c 原面板 template/style 与 B6c 完成后副本逐字节完全相等，SHA-256 均为 `72ae2a5a6645adbe237fcbd64d5e4c25f4c271a331013e249db8f2084fa7e45e`；记录见 B6d 恢复目录的 `ui-migration-verification.json`。B6d 有单独恢复点，不能把其组件迁移计为 B6c 外观变更。

联合 `settings-queue-electron.mjs` 已使用真正应用/preload/renderer、文件 SQLite 和真实第二 scope DELETE trigger，实际检验失败后 application/当前 view/其他 view/geometry rows、resolved values、runtime revision 与快捷键会话 gate/shortcut runtime 保持；UI 回读恢复 watcher gate，下一次 sticky 用户写成功；drop trigger 后同一 UI reset 重试成功，其他 scope 保留，1 秒后几何记录未重新插入，session gate 保持 false。50 个实际 assert 全部通过，0 失败/跳过、进程退出 0，正常 will-quit/windowsClosed、script/runner cleanup 与 app/detail 日志证据均完整，accepted=true。证据：`tmp/test-runs/2026-10-09T01-48-43-449Z-vFgufD/`。

专项消费一次共享稳定 build，未重复构建，全部 out hash 和来源/非认证复用边界由 B6d baseline helper 记录。Q001 的后端原子 reset 由主代理独立修复，本队列保留 reject 回读语义。系统开机启动、所有 native blur 状态、安装/客户机器/所有 DPI 与显示器不在该 GUI 证明范围；未运行全量。

## 回退与后续执行

成组恢复面板四类保存/回填/reset/dispose 和其新增 queue/protection；B6d 已迁表单时应局部接回这些调用，不整文件覆盖 B6d。恢复原 panel drag-end/raw blur 也会恢复已复现的排序问题，应明确列为风险。不能只删队列同时保留新调用，不能让新旧 gate 同时管理一类写入。

后端原子 reset、真实用户库、应用发布和其他域不属于本阶段回退。专项仅使用 runner 的私有 profile，失败证据保留；无真实用户数据重置。后续修改新设置时明确归属 application/view/session/OS，再选择普通设置或对应专属 native DTO；禁止为了一个控件加第二个写队列。
