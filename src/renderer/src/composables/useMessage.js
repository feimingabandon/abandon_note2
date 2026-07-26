/**
 * useMessage.js — 轻量消息提醒（Apple / Element UI Message 风格）
 *
 * 用法：
 *   // 在根组件中调用一次 createMessageProvider()
 *   // 在任意子孙组件中：
 *   const { showMessage } = useMessage()
 *   showMessage('success', '开机自启已开启')
 *   showMessage('error', '设置失败，请重试', 4000)
 */

import { ref, provide, inject } from 'vue'

const MESSAGE_KEY = Symbol('message')

/** 在根组件中调用，注册消息能力到整个组件树 */
export function createMessageProvider() {
  const messages = ref([])
  let _id = 0

  /**
   * 显示一条消息
   * @param {'success'|'error'|'warning'} type - 消息类型
   * @param {string} text - 消息文本
   * @param {number} [duration=2500] - 显示时长（ms），0 表示不自动关闭
   */
  function showMessage(type, text, duration = 2500) {
    const msg = { id: ++_id, type, text }
    messages.value.push(msg)

    if (duration > 0) {
      setTimeout(() => {
        messages.value = messages.value.filter((m) => m.id !== msg.id)
      }, duration)
    }

    return msg
  }

  /** 手动关闭指定消息 */
  function closeMessage(id) {
    messages.value = messages.value.filter((m) => m.id !== id)
  }

  const ctx = { messages, showMessage, closeMessage }
  provide(MESSAGE_KEY, ctx)
  // 返回上下文，便于根组件（provider 自身）直接使用 showMessage。
  return ctx
}

/** 在任意子孙组件中调用，获取消息方法 */
export function useMessage() {
  const ctx = inject(MESSAGE_KEY)
  if (!ctx) {
    // 优雅降级：未注册时返回空操作，避免崩溃
    console.warn('[useMessage] 未检测到 createMessageProvider()，请在根组件中调用')
    return {
      messages: ref([]),
      showMessage: () => {},
      closeMessage: () => {}
    }
  }
  return ctx
}
