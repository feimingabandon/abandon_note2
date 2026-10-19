import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'
import { describe, expect, it, vi } from 'vitest'
import {
  enforceWindowsPlatform,
  getWindowsPlatformCompatibility
} from '../src/shared/platform-support.js'

describe('Windows-only startup', () => {
  it.each(['darwin', 'linux', 'unsupported-platform'])(
    'refuses %s before admitting startup',
    (platform) => {
      const report = vi.fn()
      const exit = vi.fn()
      expect(enforceWindowsPlatform({ platform, report, exit })).toBe(false)
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' }))
      expect(exit).toHaveBeenCalledExactlyOnceWith(1)
      expect(getWindowsPlatformCompatibility(platform)).toMatchObject({
        success: false,
        required: true
      })
    }
  )

  it('allows Windows without refusal or exit', () => {
    const report = vi.fn()
    const exit = vi.fn()
    expect(enforceWindowsPlatform({ platform: 'win32', report, exit })).toBe(true)
    expect(getWindowsPlatformCompatibility('win32')).toMatchObject({ success: true, error: null })
    expect(report).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('still exits when refusal output fails', () => {
    const exit = vi.fn()
    expect(() =>
      enforceWindowsPlatform({
        platform: 'unsupported-platform',
        report: () => {
          throw new Error('output unavailable')
        },
        exit
      })
    ).toThrow('output unavailable')
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('keeps logger initialization and application import inside the real bootstrap admission', () => {
    const ast = parse(readFileSync('src/main/bootstrap.js', 'utf8'), { sourceType: 'module' })
    const executable = ast.program.body.filter((node) => node.type !== 'ImportDeclaration')
    expect(executable).toHaveLength(1)
    const gate = executable[0]
    expect(gate.type).toBe('IfStatement')
    expect(gate.test.callee.name).toBe('enforceWindowsPlatform')
    expect(gate.alternate).toBeNull()
    const calls = gate.consequent.body
      .filter((node) => node.type === 'ExpressionStatement')
      .map((node) => node.expression)
    expect(calls.some((call) => call.callee?.name === 'initializeLogger')).toBe(true)
    expect(
      calls.some(
        (call) =>
          call.callee?.object?.type === 'CallExpression' &&
          call.callee.object.callee.type === 'Import' &&
          call.callee.object.arguments[0].value === './index.js'
      )
    ).toBe(true)
  })
})
