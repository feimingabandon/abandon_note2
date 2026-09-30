/** A single animation shared by all active reminder rounds, including pre-tray startup. */
export class TrayReminderController {
  constructor({ normalIcon, alertIcon, intervalMs = 500, timers = globalThis }) {
    Object.assign(this, { normalIcon, alertIcon, intervalMs, timers })
    this.ids = new Set()
    this.silenced = new Set()
    this.tray = null
    this.timer = null
    this.alternate = false
  }

  attach(tray) {
    this.tray = tray
    this.update()
  }

  setBaseIcon(icon) {
    this.normalIcon = icon
    if (this.tray && !this.tray.isDestroyed() && !this.alternate) this.tray.setImage(icon)
  }

  sync(ids) {
    this.ids = new Set(ids)
    this.silenced = new Set([...this.silenced].filter((id) => this.ids.has(id)))
    this.update()
  }

  acknowledge() {
    this.silenced = new Set(this.ids)
    this.update()
  }

  update() {
    const shouldBlink = [...this.ids].some((id) => !this.silenced.has(id))
    if (!shouldBlink || !this.tray || this.tray.isDestroyed()) {
      this.stop()
      return
    }
    if (this.timer !== null) return
    this.timer = this.timers.setInterval(() => {
      if (!this.tray || this.tray.isDestroyed()) {
        this.stop()
        return
      }
      this.alternate = !this.alternate
      this.tray.setImage(this.alternate ? this.alertIcon : this.normalIcon)
    }, this.intervalMs)
  }

  stop() {
    if (this.timer !== null) this.timers.clearInterval(this.timer)
    this.timer = null
    this.alternate = false
    if (this.tray && !this.tray.isDestroyed()) this.tray.setImage(this.normalIcon)
  }

  dispose() {
    this.stop()
    this.tray = null
    this.ids.clear()
    this.silenced.clear()
  }
}
