# 集中质量验收的三个测试断言窄修

日期：2026-10-10。先建立本指导再改测试；只处理当前质量attempt明确失败，不修改生产代码、运动算法或UI，不生成安装包。

## 证据、范围与修改步骤

首失败来源 `tmp/test-runs/2026-10-10T07-52-09-968Z-6DjHnz`：189目标184通过5失败。附件两项仍待处理，41指导尚未建立；本批只处理下面三个失败，原attempt保持不变。恢复点 `tmp/beta-readiness/quality-static-unit-before-20261010/` 保存三个unit入场文件与SHA256。

1. `tests/dock-main-wiring.test.js` 仍要求隐藏/显露日常日志无条件调用完整native snapshot。当前25已将完整snapshot/display归深度，生产代码明确使用 `isDeepDiagnosticMode()` 条件；其余耗时、状态observer和逐帧低噪声检查保留。本次更新两个源码保护为要求深度条件，不能删除日志保护或改回日常昂贵采集。真实开销专项尚未运行，不由此static断言认证开销。
2. `tests/tag-color-setting.test.js` 按固定两空格截取handler结束，但当前set-setting handler位于四空格作用域，结束索引为-1导致空字符串。改按下一个 `mainWindowIpc.handle(` 调用定位边界，并显式要求起止索引有效；原allowlist包含tag设置、handler检查allowlist和持久化调用三个保护保留。不改变授权、schema或renderer产品行为。
3. `tests/run-focused-tests.test.js` 新包内调度保护把同步prepare异常当Promise rejection，异常在expect前抛出。用同步 `toThrow` 验证缺显式候选路径仍拒绝，保留Node命令、owned profile与无证据写入检查。不能改prepare为静默fallback或给旧安装包默认路径。

## 验证、恢复与边界

只运行这三个指定unit及必要格式/lint；已通过的其它质量目标不全量重跑。run-focused内含自身受控dispatch，继续使用短的私有fixture目录，失败证据保留。包内准备unit只检查启动前门槛，不能算真实应用或包内业务通过。

恢复仅用本批三文件副本，保留其它dirty成果；附件fixture、Qt与包内测试的修改另有各自恢复来源。用户要求先做后续产品修改，固定候选、打包与包内验收暂停。本批只关闭已确认的测试错误。

## 实际结果

局部 attempt `tmp/test-runs/2026-10-10T08-01-18-961Z-FLoV2w` 已完成：Dock 8/8、focused runner 14/14、tag 3/3，共25个Vitest用例，三个目标均accepted=true，退出码0。已读回最终 `run-report-status.json`：phase=final、finalRun=true、generation=3、status=complete；completion同代次，三个case报告及cleanup完整。指定测试文件格式/lint通过。以上只关闭三个测试断言错误，不能覆盖原集中质量attempt的五项失败，更不能称189项当前全部通过。

附件重置unit的rename EPERM原因尚未独立确认；附件storage fixture缺少journal表的修正尚未实施。Qt修正未重新编译运行，真实运动开销、日报GUI和包内验收未执行。用户要求暂停打包后，本次仅核对已保存证据及同步指导，没有新增运行测试、构建或生成安装包。
