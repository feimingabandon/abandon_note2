export function isComposingInput(event) {
  return Boolean(event?.isComposing || event?.keyCode === 229)
}
