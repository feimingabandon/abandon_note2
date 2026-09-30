// One queue per renderer window. A ticket keeps its place through the leave animation.
export function createModalQueue() {
  const tickets = []
  const holds = new Set()
  let active = null

  function advance() {
    if (active || holds.size) return
    active = tickets[0] || null
    active?.activate()
  }

  return {
    enqueue(activate) {
      const ticket = { activate }
      tickets.push(ticket)
      advance()
      let released = false
      return () => {
        if (released) return
        released = true
        const index = tickets.indexOf(ticket)
        if (index >= 0) tickets.splice(index, 1)
        if (active === ticket) active = null
        advance()
      }
    },
    // A confirmation/preview belongs to the current operation. It must be able
    // to finish that operation, while preventing unrelated queued dialogs opening.
    hold() {
      const token = Symbol('modal-child')
      holds.add(token)
      return () => {
        holds.delete(token)
        advance()
      }
    }
  }
}

export const modalQueue = createModalQueue()
