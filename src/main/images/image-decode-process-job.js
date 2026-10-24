import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const ERROR_MORE_DATA = 234
let nativeApi

function failure(code, message, details = {}) {
  return Object.assign(new Error(message || code), { code, ...details })
}

function win32() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw failure('IMAGE_DECODER_JOB_PLATFORM', 'Image decoder jobs require Windows x64')
  if (nativeApi) return nativeApi
  const koffi = require('koffi')
  const kernel = koffi.load('kernel32.dll')
  nativeApi = {
    createJob: kernel.func('intptr_t __stdcall CreateJobObjectW(void *, const char16_t *)'),
    setInformation: kernel.func(
      'int __stdcall SetInformationJobObject(intptr_t, int, const void *, uint32_t)'
    ),
    queryInformation: kernel.func(
      'int __stdcall QueryInformationJobObject(intptr_t, int, void *, uint32_t, void *)'
    ),
    assign: kernel.func('int __stdcall AssignProcessToJobObject(intptr_t, intptr_t)'),
    terminate: kernel.func('int __stdcall TerminateJobObject(intptr_t, uint32_t)'),
    openProcess: kernel.func('intptr_t __stdcall OpenProcess(uint32_t, int, uint32_t)'),
    isProcessInJob: kernel.func('int __stdcall IsProcessInJob(intptr_t, intptr_t, void *)'),
    closeHandle: kernel.func('int __stdcall CloseHandle(intptr_t)'),
    lastError: kernel.func('uint32_t __stdcall GetLastError()')
  }
  return nativeApi
}

/**
 * Owns one private Windows Job. KILL_ON_JOB_CLOSE is the only limit: neither
 * BREAKAWAY_OK nor SILENT_BREAKAWAY_OK is enabled. Nested membership therefore
 * cannot let a decoder-created process escape this job.
 *
 * attachRoot is NOT a retroactive process-tree capture. The caller must use a
 * launch gate whose root cannot spawn children before assignment, then launch
 * the actual Electron decoder inside that gate. Assigning an already-running
 * Electron browser PID does not establish this contract; an empty Job would
 * then prove only the assigned members, not unobserved early descendants.
 */
export function createImageDecodeProcessJob() {
  const api = win32()
  let handle = api.createJob(null, null)
  if (!handle)
    throw failure('IMAGE_DECODER_JOB_CREATE', 'CreateJobObjectW failed', {
      win32Code: api.lastError()
    })
  let rootPid
  const nativeFailure = (code, operation, details = {}) =>
    failure(code, `${operation} failed`, { win32Code: api.lastError(), ...details })
  const requireHandle = () => {
    if (!handle) throw failure('IMAGE_DECODER_JOB_CLOSED', 'Image decoder Job handle is closed')
    return handle
  }
  const closeProcess = (processHandle, priorFailure) => {
    if (!api.closeHandle(processHandle)) {
      const error = nativeFailure('IMAGE_DECODER_PROCESS_HANDLE_CLOSE', 'CloseHandle(process)')
      if (!priorFailure) throw error
      priorFailure.closeError = error
    }
  }
  const withProcess = (pid, access, action) => {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff)
      throw failure('IMAGE_DECODER_JOB_PID', 'Only an owned child PID can be attached or queried', {
        pid
      })
    const processHandle = api.openProcess(access, 0, pid)
    if (!processHandle) throw nativeFailure('IMAGE_DECODER_PROCESS_OPEN', 'OpenProcess', { pid })
    let error
    try {
      return action(processHandle)
    } catch (caught) {
      error = caught
      throw caught
    } finally {
      closeProcess(processHandle, error)
    }
  }
  const containsHandle = (processHandle) => {
    const value = Buffer.alloc(4)
    if (!api.isProcessInJob(processHandle, requireHandle(), value))
      throw nativeFailure('IMAGE_DECODER_JOB_MEMBERSHIP', 'IsProcessInJob')
    return value.readInt32LE() !== 0
  }
  try {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on Windows x64.
    // BasicLimitInformation.LimitFlags is a DWORD at offset 16.
    const limits = Buffer.alloc(144)
    limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16)
    if (!api.setInformation(handle, 9, limits, limits.length))
      throw nativeFailure('IMAGE_DECODER_JOB_LIMITS', 'SetInformationJobObject')
  } catch (error) {
    if (!api.closeHandle(handle))
      error.closeError = nativeFailure('IMAGE_DECODER_JOB_HANDLE_CLOSE', 'CloseHandle(job)')
    handle = null
    throw error
  }

  const activeProcesses = () => {
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION is 48 bytes; ActiveProcesses at 40.
    const accounting = Buffer.alloc(48)
    if (!api.queryInformation(requireHandle(), 1, accounting, accounting.length, null))
      throw nativeFailure('IMAGE_DECODER_JOB_ACCOUNTING', 'QueryInformationJobObject(accounting)')
    return accounting.readUInt32LE(40)
  }

  return {
    attachRoot(pid) {
      requireHandle()
      if (pid === process.pid)
        throw failure('IMAGE_DECODER_JOB_PID', 'The owner process cannot enter its decoder Job')
      if (rootPid)
        throw failure('IMAGE_DECODER_JOB_ROOT_ATTACHED', 'A Job admits only one owned launch root')
      return withProcess(
        pid,
        PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
        (processHandle) => {
          if (!api.assign(handle, processHandle))
            throw nativeFailure('IMAGE_DECODER_JOB_ATTACH', 'AssignProcessToJobObject', { pid })
          rootPid = pid
          if (!containsHandle(processHandle))
            throw failure('IMAGE_DECODER_JOB_ROOT_UNCONFIRMED', 'Assigned root membership absent', {
              pid
            })
          return { rootPid: pid, activeProcesses: activeProcesses() }
        }
      )
    },
    activeProcesses,
    contains(pid) {
      requireHandle()
      return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, containsHandle)
    },
    processIds() {
      requireHandle()
      let capacity = Math.max(16, activeProcesses() + 8)
      for (let attempt = 0; attempt < 5; attempt++) {
        if (capacity > 65536)
          throw failure('IMAGE_DECODER_JOB_MEMBER_LIMIT', 'Unexpected decoder process count')
        // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR IDs.
        const list = Buffer.alloc(8 + capacity * 8)
        if (api.queryInformation(handle, 3, list, list.length, null)) {
          const count = list.readUInt32LE(4)
          if (count > capacity)
            throw failure('IMAGE_DECODER_JOB_MEMBER_DATA', 'Invalid Job process-list length')
          return Array.from({ length: count }, (_, index) =>
            Number(list.readBigUInt64LE(8 + index * 8))
          )
        }
        const win32Code = api.lastError()
        if (win32Code !== ERROR_MORE_DATA)
          throw failure(
            'IMAGE_DECODER_JOB_MEMBERS',
            'QueryInformationJobObject(process IDs) failed',
            {
              win32Code
            }
          )
        capacity = Math.max(capacity * 2, list.readUInt32LE(0) + 8)
      }
      throw failure('IMAGE_DECODER_JOB_MEMBERS_UNSTABLE', 'Job process list did not stabilize')
    },
    terminate(exitCode = 1) {
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 0xffffffff)
        throw failure('IMAGE_DECODER_JOB_EXIT_CODE', 'A Win32 DWORD exit code is required')
      if (!api.terminate(requireHandle(), exitCode))
        throw nativeFailure('IMAGE_DECODER_JOB_TERMINATE', 'TerminateJobObject', { rootPid })
      // Termination request does not establish that any process has exited.
    },
    async waitForEmpty({ timeoutMs = 5000, pollIntervalMs = 20 } = {}) {
      if (
        !Number.isFinite(timeoutMs) ||
        timeoutMs < 0 ||
        timeoutMs > 60000 ||
        !Number.isFinite(pollIntervalMs) ||
        pollIntervalMs < 1 ||
        pollIntervalMs > 1000
      )
        throw failure('IMAGE_DECODER_JOB_WAIT_OPTIONS', 'A bounded Job wait is required')
      const deadline = performance.now() + timeoutMs
      for (;;) {
        const active = activeProcesses()
        if (active === 0) return { activeProcesses: 0, rootPid }
        const remaining = deadline - performance.now()
        if (remaining <= 0)
          throw failure('IMAGE_DECODER_JOB_NOT_EMPTY', 'Owned Job still has active processes', {
            rootPid,
            activeProcesses: active,
            timeoutMs
          })
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)))
      }
    },
    close() {
      if (!handle) return { closed: true, activeProcesses: 0 }
      const active = activeProcesses()
      if (active !== 0)
        throw failure(
          'IMAGE_DECODER_JOB_CLOSE_ACTIVE',
          'Wait for Job emptiness before handle close',
          {
            rootPid,
            activeProcesses: active
          }
        )
      if (!api.closeHandle(handle))
        throw nativeFailure('IMAGE_DECODER_JOB_HANDLE_CLOSE', 'CloseHandle(job)', { rootPid })
      handle = null
      return { closed: true, activeProcesses: 0 }
    }
  }
}
