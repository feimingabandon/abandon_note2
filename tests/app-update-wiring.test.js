import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

describe('应用更新入口接线', () => {
  it('为同版本和降级操作显示确认，并提交绑定当前检查的完整请求', () => {
    const source = read('src/renderer/src/components/system/UpdateDialog.vue')
    expect(source).toContain("props.result?.relation === 'downgrade'")
    expect(source).toContain('确认下载旧版本？')
    expect(source).toContain('确认重新下载安装包？')
    expect(source).toContain('<ConfirmDialog')
    expect(source).toContain('checkId: props.result?.checkId')
    expect(source).toContain('targetVersion: props.result?.latestVersion')
    expect(source).toContain('relation: props.result?.relation')
  })

  it('由主进程重新验证检查身份后再打开外部地址', () => {
    const preload = read('src/preload/index.js')
    const main = read('src/main/index.js')
    expect(preload).toContain("ipcRenderer.invoke('update:open-link', request)")
    expect(main).toContain('appUpdateService.getExternalUrl(request)')
  })

  it('在更新弹窗中安全显示 Release 更新说明', () => {
    const source = read('src/renderer/src/components/system/UpdateDialog.vue')
    expect(source).toContain("String(props.result?.releaseNotes || '').trim()")
    expect(source).toContain('本次更新')
    expect(source).toContain('{{ releaseNotes }}')
    expect(source).not.toContain('v-html')
  })
})
