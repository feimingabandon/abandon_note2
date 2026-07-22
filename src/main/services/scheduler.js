/**
 * scheduler.js — 统一调度器（零依赖）
 *
 * 设计原则：整个应用有且仅有一个定时调度中枢，所有周期性任务统一注册、统一管理。
 *
 * 核心机制：
 *   1. 主线：递归 setTimeout 精确对齐整分（每分钟 tick 一次，零漂移）
 *   2. 看门狗：独立 setInterval 每 5 分钟检查主线是否存活
 *   3. 代数去重：防止系统休眠恢复时产生多条主线并行
 *   4. 任务熔断：单个任务连续失败 10 次自动禁用
 *   5. 终极告警：看门狗 3 次恢复失败（15 分钟）→ 操作系统通知
 */

/**
 * @typedef {Object} SchedulerTask
 * @property {string} name - 任务名称
 * @property {() => boolean} shouldRun - 条件函数：返回 true 表示应执行
 * @property {() => void} execute - 执行函数
 * @property {number} [failures] - 连续失败计数（调度器维护）
 * @property {string|null} [lastError] - 最后一次错误信息
 * @property {boolean} [_disabled] - 是否已被自动禁用
 * @property {number} [maxFailures=10] - 自动禁用阈值；Infinity 表示永不自动禁用
 */

export class Scheduler {
  /** @type {SchedulerTask[]} */
  tasks = []

  /** 主线递归 setTimeout 句柄 */
  _mainTimerId = null

  /** 看门狗 setInterval 句柄 */
  _watchdogId = null

  /** 防止 tick 重叠执行 */
  _ticking = false

  /** 主线代数（每次重启主线 +1，用于废弃旧主线回调） */
  _mainGeneration = 0

  /** 看门狗连续恢复失败计数（成功 tick 后清零） */
  _recoveryFailures = 0

  /** 上次 tick 完成的时间戳（毫秒），用于看门狗诊断 */
  lastTickAt = null

  /** Electron Notification 引用（操作系统原生通知，延迟 require 避免测试环境无此模块） */
  _Notification = null

  // ============================================================
  // 注册
  // ============================================================

  /**
   * 注册条件式任务
   * @param {SchedulerTask} task
   */
  register(task) {
    this.tasks.push({
      ...task,
      failures: 0,
      lastError: null
    })
  }

  /**
   * 注册定时式任务（语法糖：每天指定时刻执行）
   * @param {string} timeStr - HH:mm 格式
   * @param {() => void} callback
   */
  scheduleAt(timeStr, callback) {
    const [h, m] = timeStr.split(':').map(Number)
    this.register({
      name: `at_${timeStr}`,
      shouldRun: () => {
        const now = new Date()
        return now.getHours() === h && now.getMinutes() === m
      },
      execute: callback
    })
  }

  // ============================================================
  // 启动 / 停止
  // ============================================================

  /**
   * 启动调度器（主线 + 看门狗）
   */
  start() {
    this.lastTickAt = Date.now() // 初始化，防止首次 tick 失败导致看门狗永不触发

    // 启动时仍执行一轮任务，但把来源交给各任务决定是否补偿；循环模板会跳过旧节点。
    this.tick({ reason: 'startup' })

    // === 主线：递归 setTimeout 精确到整分 ===
    const myGen = ++this._mainGeneration

    const scheduleTick = () => {
      if (this._mainGeneration !== myGen) return // 已被新主线替代，停止

      const msToNextMinute = 60000 - (Date.now() % 60000)
      this._mainTimerId = setTimeout(() => {
        if (this._mainGeneration !== myGen) return // 二次校验（系统恢复时防竞态）
        this.tick({ reason: 'scheduled' })
        scheduleTick()
      }, msToNextMinute)
    }

    scheduleTick()

    // === 看门狗：每 5 分钟独立检查 ===
    this._watchdogId = setInterval(
      () => {
        if (this.lastTickAt && Date.now() - this.lastTickAt > 2 * 60 * 1000) {
          this._recoveryFailures++
          console.warn(
            `[scheduler] 主线失活（距上次 tick >2min），第${this._recoveryFailures}次恢复`
          )

          // 连续 3 次恢复失败（15 分钟）→ 终极告警
          if (this._recoveryFailures >= 3) {
            this._sendAlert()
            this._recoveryFailures = 0 // 重置，避免重复弹出操作系统通知
          }

          // 递增代数 → 所有旧主线回调自检失败
          const newGen = ++this._mainGeneration
          this.tick({ reason: 'recovery' })

          // 清除旧主线 timer（已入队的回调通过代数校验过滤）
          clearTimeout(this._mainTimerId)

          // 启动新代数主线
          const rebuild = () => {
            if (this._mainGeneration !== newGen) return
            const ms = 60000 - (Date.now() % 60000)
            this._mainTimerId = setTimeout(() => {
              if (this._mainGeneration !== newGen) return
              this.tick({ reason: 'scheduled' })
              rebuild()
            }, ms)
          }
          rebuild()
        }
      },
      5 * 60 * 1000
    )
  }

  /**
   * 停止调度器（清理所有定时器）
   */
  stop() {
    if (this._mainTimerId) {
      clearTimeout(this._mainTimerId)
      this._mainTimerId = null
    }
    if (this._watchdogId) {
      clearInterval(this._watchdogId)
      this._watchdogId = null
    }
  }

  // ============================================================
  // tick：每一分钟执行一次
  // ============================================================

  tick({ reason = 'scheduled' } = {}) {
    if (this._ticking) return // 上一轮未结束，跳过本轮
    this._ticking = true

    const tickStartedAt = Date.now()
    const previousTickAt = this.lastTickAt
    const effectiveReason =
      reason === 'scheduled' && previousTickAt && tickStartedAt - previousTickAt > 90_000
        ? 'recovery'
        : reason
    const context = { now: tickStartedAt, reason: effectiveReason, previousTickAt }

    const stats = { total: 0, skipped: 0, ran: 0, ok: [], fail: [] }

    try {
      for (const task of this.tasks) {
        if (task._disabled) continue
        stats.total++

        try {
          if (task.shouldRun(context)) {
            task.execute(context)
            task.failures = 0 // 执行成功，重置失败计数
            stats.ran++
            stats.ok.push(task.name)
          } else {
            stats.skipped++
          }
        } catch (err) {
          task.failures++
          task.lastError = err.message
          stats.ran++
          stats.fail.push(`${task.name}(${err.message})`)
          console.error(`[scheduler] "${task.name}" 失败 (${task.failures}次):`, err)

          // 达到任务自己的失败阈值后自动禁用；需持续重试的任务可使用 Infinity。
          const maxFailures = task.maxFailures ?? 10
          if (Number.isFinite(maxFailures) && task.failures >= maxFailures) {
            console.error(`[scheduler] "${task.name}" 已自动禁用（连续失败${maxFailures}次）`)
            task._disabled = true
          }
        }
      }

      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      const skippedInfo = stats.skipped > 0 ? `, 跳过 ${stats.skipped}` : ''
      const okInfo = stats.ok.length > 0 ? stats.ok.join(', ') : '无'
      const failInfo = stats.fail.length > 0 ? stats.fail.join('; ') : '无'
      console.log(
        `[scheduler] tick ${ts} — 共 ${stats.total} 任务, 执行 ${stats.ran}${skippedInfo} | 成功: ${okInfo} | 失败: ${failInfo}`
      )
    } finally {
      this._ticking = false
      this.lastTickAt = Date.now()
      this._recoveryFailures = 0 // 成功主线 tick，重置看门狗恢复计数
    }
  }

  // ============================================================
  // 诊断
  // ============================================================

  /**
   * 获取调度器健康报告
   * @returns {{ status: string, tasks: Array, lastTickAt: number|null, recoveryFailures: number,
   *             watchdogRunning: boolean, mainGeneration: number, tickStuck: boolean }}
   */
  getHealth() {
    return {
      status: this._mainTimerId ? 'running' : 'stopped',
      tasks: this.tasks.map((t) => ({
        name: t.name,
        failures: t.failures,
        disabled: !!t._disabled,
        lastError: t.lastError
      })),
      lastTickAt: this.lastTickAt,
      recoveryFailures: this._recoveryFailures,
      watchdogRunning: !!this._watchdogId,
      mainGeneration: this._mainGeneration,
      tickStuck: this._ticking
    }
  }

  // ============================================================
  // 内部
  // ============================================================

  /**
   * 发送终极告警：弹出操作系统通知告知用户重启
   */
  _sendAlert() {
    console.error('[scheduler] 终极告警：所有恢复手段已耗尽，通知用户重启')
    try {
      // 延迟 require，避免非 Electron 环境崩溃
      const { Notification } = (this._Notification = this._Notification || require('electron'))
      new Notification({
        title: '便签调度器异常',
        body: '定时任务引擎连续恢复失败，请重启应用以恢复正常。',
        urgency: 'critical'
      }).show()
    } catch (e) {
      console.error('[scheduler] 无法发送操作系统通知:', e.message)
    }
  }
}
