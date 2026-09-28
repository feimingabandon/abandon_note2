// A civil calendar date, encoded in UTC only as an arithmetic container. No global
// timezone changes: cnlunar's local getters/constructors all use the same day basis.
export class CivilDate extends globalThis.Date {
  constructor(...args) {
    super(...(args.length > 1 ? [globalThis.Date.UTC(...args)] : args))
  }
  getFullYear() {
    return this.getUTCFullYear()
  }
  getMonth() {
    return this.getUTCMonth()
  }
  getDate() {
    return this.getUTCDate()
  }
  getDay() {
    return this.getUTCDay()
  }
  getHours() {
    return this.getUTCHours()
  }
  getMinutes() {
    return this.getUTCMinutes()
  }
  setDate(value) {
    return this.setUTCDate(value)
  }
}
