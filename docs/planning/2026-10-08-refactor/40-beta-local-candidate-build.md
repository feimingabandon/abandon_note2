# BR-04 本地 Windows 内测候选构建与来源指导

日期：2026-10-10。状态：用户要求先继续其它产品修改，当前暂停候选打包与包内验收，安装包尚未生成。用户明确内测与正式使用同一个1.4.0版本；验收通过后直接发布同一产物。以下为后续指导，不在产品修改完成前执行打包或交付。

## 版本与身份

保持现有稳定更新规则，package.json、package-lock.json 根版本及 packages[""] 版本统一为 `1.4.0`。使用正常安装包名 `Abandon-Note-1.4.0-windows-x64-setup.exe`，不新增beta序号、内测渠道或另一套发行身份。内测是发布前使用同一候选产物验证的阶段；没有代码变更时，后续发布复用该产物及其SHA256。

构建沿用生产 appId、GUID、协议、exe与nsis.artifactName，仅覆盖本地output；这些不是同机平行安装身份。本机不运行安装器，不覆盖正式安装，不测试生产身份注册/自启动/卸载。独立目录启动必须显式使用测试自有profile与integration flag；该flag不能隔离安装器，见34。

## 实施顺序

1. 保存 package.json、package-lock.json 入场字节与SHA256，仅修改以上三个根版本字段，不改任何依赖解析或发布工作流。
2. 收齐33/35/36/37/38窄修并完成局部验收，再按32明确范围执行一次固定候选的unit/数据库/存储质量门槛。小修仅重跑受影响项目，失败及修复前结果保留。
3. 使用AGENTS固定Node与去Volta的PATH。unit写缓存、app构建、native/Qt构建和共享证据测试串行；native外部闭包未认证时重建，不能强制reuse。
4. app/native/capture与实际输入驱动就绪后，真实应用专项串行验证32主链、35开销及37日报。未适配legacy不强行包一层exit0结果；明确遗留和未覆盖项。
5. 所有生产来源固定后，记录git HEAD及完整dirty来源文件SHA256、删除项、package/lock、out、DLL ABI22、capture deploy、固定Node/Electron/Qt/MSVC与build proof。HEAD不能代表dirty候选。
6. 通过项目内electron-builder JavaScript入口构建Windows x64 NSIS，明确 `--publish never`，output限定 `tmp/beta-readiness/candidate-1.4.0`，安装包沿用正常命名规则。保留builder原beforePack/afterPack验证，不关闭sandbox/GPU，不上传。
7. 显式指定本次win-unpacked路径执行38包内专项。真实截图、截图附件便签保存/同profile冷重启、快捷键恢复、ASAR日志Worker导出及app/helper退出全部通过，才可记包内候选门槛通过。记录包内version、DLL/native/Qt身份与安装器/ASAR/exe的SHA256。
8. 汇总实际结果、失败/未覆盖、用户反馈步骤、产物位置与恢复来源。Windows10、真实双屏/混合DPI、生产GUID旧版本安装升级/卸载和自然卡顿不能从本机源树GUI或unpacked结果推导为通过。

## 失败、恢复与完成条件

资料损坏、启动/保存/诊断失败和helper泄漏继续作为阻塞处理。构建或业务断言失败不换预期获取通过；候选源码变更后只重跑受影响门槛并重新记录产物身份。

版本恢复仅用本批入场package/lock副本，不能覆盖之前的Windows-only脚本与依赖修改。候选output可保留作为证据；若清理须确认绝对路径属于上述唯一output。测试profile由runner按owner处理，失败现场保留，不读写正式资料。

完成条件为：版本一致、来源可追溯、本地构建/包完整性/包内关键链有效、阻塞项关闭且外部环境缺口明确交付。缺隔离安装环境时仍不能称生产安装升级验收或正式1.4.0发布完成。

## 实际结果

package.json与package-lock.json三个根版本字段已统一1.4.0，依赖未更改；恢复点 `tmp/beta-readiness/candidate-version-before-20261010/`。集中质量 attempt `tmp/test-runs/2026-10-10T07-52-09-968Z-6DjHnz` 共189目标，184通过、5失败，exit1；不能称候选就绪。用户随后明确不要生成安装包，候选来源冻结、electron-builder、安装器和包内验收均暂停；没有生成或运行安装包。后续产品修改完成后按实际影响重验，再决定构建。

暂停前后的准确收尾见[42](42-quality-unit-assertion-repair.md)：三个测试断言窄修局部通过，附件两个失败未关闭；Qt修正尚未重新编译运行。35真实运动开销、37日报GUI和38包内专项均未运行。38脚本还需收尾超时/清理与明确1.4.0版本断言，再执行包内验收；静态脚本或版本字段一致不能代替产物验证。
