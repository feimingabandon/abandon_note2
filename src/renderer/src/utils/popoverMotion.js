/**
 * 浮动弹层统一动效。
 * menu：macOS 式锚点淡入；reveal：大面板从触发器方向裁剪揭示，不拉伸文字。
 */
const runningAnimations = new WeakMap()

const MOTIONS = {
  menu: {
    enter: [
      { opacity: 0, transform: 'translateY(-4px) scale(0.985)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ],
    leave: [
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(-3px) scale(0.99)' }
    ],
    enterDuration: 180,
    leaveDuration: 140
  },
  reveal: {
    enter: [
      {
        opacity: 0.35,
        transform: 'translateY(-5px)',
        clipPath: 'inset(0 0 100% 0 round 10px)'
      },
      {
        opacity: 1,
        transform: 'translateY(0)',
        clipPath: 'inset(0 0 0 0 round 10px)'
      }
    ],
    leave: [
      {
        opacity: 1,
        transform: 'translateY(0)',
        clipPath: 'inset(0 0 0 0 round 10px)'
      },
      {
        opacity: 0,
        transform: 'translateY(-4px)',
        clipPath: 'inset(0 0 100% 0 round 10px)'
      }
    ],
    enterDuration: 240,
    leaveDuration: 180
  }
}

function run(el, done, kind, direction) {
  runningAnimations.get(el)?.cancel()
  const motion = MOTIONS[kind] || MOTIONS.menu
  const entering = direction === 'enter'
  const animation = el.animate(entering ? motion.enter : motion.leave, {
    duration: entering ? motion.enterDuration : motion.leaveDuration,
    easing: entering ? 'cubic-bezier(0.32, 0.72, 0, 1)' : 'ease-out',
    fill: 'both'
  })
  runningAnimations.set(el, animation)

  const finish = () => {
    if (runningAnimations.get(el) === animation) runningAnimations.delete(el)
    done()
  }
  animation.finished.then(finish, finish)
}

export function enterPopover(el, done, kind = 'menu') {
  run(el, done, kind, 'enter')
}

export function leavePopover(el, done, kind = 'menu') {
  run(el, done, kind, 'leave')
}
