/** Owns the main-window restoration ticket for one capture. Host/assets/ACK stay in CaptureCoordinator. */
export function createCaptureWindowIntegration({
  getWindow,
  isDockHidden = () => false,
  shouldHide,
  isQuitting,
  suspendDock,
  resumeDock,
  hideWindow,
  reassertZOrder,
  openBusiness
}) {
  let ticket = null
  const currentTicketWindow = (snapshot) => {
    const window = getWindow()
    return window && window === snapshot.window && !window.isDestroyed() ? window : null
  }
  return {
    isActive: () => Boolean(ticket),
    snapshot: () => ({
      active: Boolean(ticket),
      wasVisible: ticket?.wasVisible ?? false,
      wasFocused: ticket?.wasFocused ?? false,
      hidden: ticket?.hidden ?? false
    }),
    openBusiness,
    begin() {
      if (ticket) return
      const window = getWindow()
      const live = window && !window.isDestroyed()
      const dockHidden = Boolean(live && isDockHidden())
      ticket = {
        window,
        wasVisible: Boolean(live && window.isVisible()),
        wasFocused: Boolean(live && window.isFocused()),
        hidden: Boolean(shouldHide() && live && window.isVisible() && !dockHidden)
      }
      suspendDock('screenshot', { preserveHidden: true })
      if (ticket.hidden) hideWindow(window)
    },
    finish(_origin, business = {}) {
      if (!ticket) return
      const snapshot = ticket
      ticket = null
      resumeDock('screenshot')
      if (isQuitting()) return
      const window = currentTicketWindow(snapshot)
      if (!window) return
      if (snapshot.hidden) {
        window.showInactive()
        if (snapshot.wasFocused) window.focus()
        reassertZOrder('screenshot-finished')
      }
      if (business.businessOpened && !business.businessAccepted && !snapshot.wasVisible) {
        hideWindow(window)
      }
    }
  }
}
