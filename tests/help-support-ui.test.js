import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const HELP_PAGE_PATH = new URL('../src/renderer/src/components/help/HelpPage.vue', import.meta.url)

describe('help project support information', () => {
  it('shows both repositories, the author blog, and the email in the home support card', () => {
    const source = readFileSync(HELP_PAGE_PATH, 'utf8')
    const homeSupportCard = source.match(
      /<div class="help-home-card">\s*<h3>项目与支持<\/h3>([\s\S]*?)<\/div>/
    )?.[1]

    expect(homeSupportCard).toContain('GitCode 仓库')
    expect(homeSupportCard).toContain(':href="profile.gitcode"')
    expect(homeSupportCard).toContain('GitHub 仓库')
    expect(homeSupportCard).toContain(':href="profile.github"')
    expect(homeSupportCard).toContain('作者博客')
    expect(homeSupportCard).toContain(':href="profile.blog"')
    expect(homeSupportCard).toContain('联系邮箱')
    expect(homeSupportCard).toContain('{{ profile.email }}')
    expect(homeSupportCard?.match(/rel="noopener noreferrer"/g)).toHaveLength(3)
  })
})
