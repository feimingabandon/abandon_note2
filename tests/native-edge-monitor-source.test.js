import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve('native_blur/window_motion_edge_monitor.cpp'), 'utf8')

describe('Windows native edge monitor source invariants', () => {
  it('accepts a complete handle click while the reveal animation is still appearing', () => {
    const windowProcedure = source.slice(
      source.indexOf('LRESULT CALLBACK HandleWndProc'),
      source.indexOf('bool EnsureHandleWindowClass')
    )
    const animationCompletion = source.slice(
      source.indexOf('void UpdateHandleAnimation'),
      source.indexOf('void UpdateHandleVisual')
    )

    expect(source).toContain(
      'return phase == HandlePhase::Appearing || phase == HandlePhase::Ready;'
    )
    expect(
      windowProcedure.match(/IsHandleClickablePhase\(runtime->handlePhase\.load\(\)\)/g)
    ).toHaveLength(2)
    expect(animationCompletion).not.toContain('runtime.handleButtonDownInside = false;')
  })

  it('keeps temporary cursor-unavailable periods degraded instead of opening the main window', () => {
    const worker = source.slice(
      source.indexOf('unsigned __stdcall WorkerThreadProc'),
      source.indexOf('int StopLocked')
    )
    const failureStart = worker.indexOf('if (!GetCursorPos(&cursor))')
    const failureEnd = worker.indexOf('if (UsesRevealHandle(*runtime))', failureStart)
    const cursorRecovery = worker.slice(failureStart, failureEnd)

    expect(cursorRecovery).toContain('runtime->state.store(State::Degraded);')
    expect(cursorRecovery).toContain(
      'runtime->lastError.store(static_cast<int>(Result::CursorUnavailable));'
    )
    expect(cursorRecovery).not.toContain('QueueEvent(')
    expect(cursorRecovery).toContain('runtime->cursorFailureCount.exchange(0)')
    expect(cursorRecovery).toContain(
      'runtime->state.store(inside ? State::WaitingOutside : State::Armed);'
    )
    expect(cursorRecovery).toContain('previousInside = inside;')
  })
})
