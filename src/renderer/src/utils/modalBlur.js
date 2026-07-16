let modalBlurCount = 0

function syncModalBlurClass() {
  document.body.classList.toggle('has-modal-blur', modalBlurCount > 0)
}

/** 模态浮层存续期间，让当前可见内容层直接失焦。支持多个模态层嵌套。 */
export function retainModalBlur() {
  modalBlurCount += 1
  syncModalBlurClass()
}

export function releaseModalBlur() {
  modalBlurCount = Math.max(0, modalBlurCount - 1)
  syncModalBlurClass()
}
