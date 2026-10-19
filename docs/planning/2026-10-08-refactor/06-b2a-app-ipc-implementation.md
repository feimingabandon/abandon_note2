# B2a 简单应用 IPC 的实施与指导

2026-10-09。范围为 `app:get-info`、`update:check`、`update:open-link`，不改变 preload API、更新规则或外部链接产品策略。用户已连续授权 S5；此记录不代表全量或发布验证。

## 修改方法与真实接线

恢复基线：`tmp/refactor-baselines/B2a-2026-10-09T01-09-50-758Z`。新增 `src/main/ipc/register-app-ipc.js`，拥有三个通道的安装和撤销。主入口调用新注册器，继续传入原 mainWindowIpc，因而每次 invoke 都按当前窗口身份鉴权并保留日志包装。更新服务仍负责检查身份、构造合法链接；检查完成后才调用 shell。异常保持 reject，不把失败改成成功。

安装失败只释放本注册器已安装的通道；dispose 可重入，will-quit 释放它自己的注册。窗口、DB、更新缓存和生命周期仍各归原拥有者。不能把该模块扩成获取全部入口全局变量的服务容器。后续 IPC 迁移须以完整域注册、授权和 dispose 为单位，不能拆散一个事务命令。

消费者：主入口、原 preload 的 getAppInfo/checkForUpdate/openUpdateLink、App/Month 更新 composable、app-update-wiring 与 registry source-read。原源码读取保护已改到新注册文件，保留链接 identity 检查的语义。

## 局部验证与边界

- B2a 自己的六文件局部契约 21 个用例通过；同一次包含 B0d provenance 的报告合计 56 用例，见 `tmp/b2a-unit-results.json`，不能把35个来源 helper 用例算作应用业务断言。
- 新 `tests/app-ipc-electron.mjs` 使用真实 Electron、实际构建的主 preload、sandbox/contextIsolation 的窗口及 MainWindowHost。受控更新服务替代联网和真正打开浏览器。17 个实际 assert 全通过，当前/外部 sender、未知 target、过期 identity、更新服务调用次数、销毁重建身份、dispose 后无处理器均验收。证据：`tmp/test-runs/2026-10-09T01-35-48-843Z-OJMLjB`，accepted=true、evidence/cleanup complete。
- 必要 app build 退出0，`tmp/b3ab-app-build.log`；本批相关生产/测试文件 ESLint 最终退出0。初次新专项 lint 有 unused import，删除后通过，未放宽规则。

真实专项明确使用 B3ab/B2a/Timeline 当时冻结 out，记录输出 hashes 和 certifiedReuse=false；这是匹配构建的局部验收，不是完整工具链复用证书。无需 Qt、blur 或业务 DB；manifest 将实际 preload 构建前置和 runtime 分开。没有发起真实联网、下载、浏览器、安装或发布，不证明所有更新服务器行为。

## 后续修改规则和回退

扩展注册器先确定通道/DTO/授权及调用消费者，增加独立行为预期，再选具体 unit 和跨进程专项。鉴权必须在 handler 的副作用前；禁止用 mock sender 单测替代真实 preload 检验。回退时按基线恢复入口、source-read接线并撤本注册器/本批新专项及登记，保留其它域未提交结果；不能 reset/clean 全库。未运行全量、安装、macOS 或客户机器测试。
