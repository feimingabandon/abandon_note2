#include <string>
#include <vector>
#include <windows.h>

// Only this DLL's caller owns the non-inheritable job. No native-to-JS
// callbacks.
struct CaptureJob {
  HANDLE job;
  HANDLE process;
  DWORD pid;
};
static std::wstring quote(const wchar_t *value) {
  std::wstring out = L"\"";
  unsigned slashes = 0;
  for (const wchar_t *p = value; *p; ++p) {
    if (*p == L'\\') {
      ++slashes;
      continue;
    }
    out.append(*p == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0;
    out += *p;
  }
  out.append(slashes * 2, L'\\');
  out += L'"';
  return out;
}
extern "C" __declspec(dllexport) void *__cdecl
CaptureLaunch(const wchar_t *exe, const wchar_t *pipe, const wchar_t *token,
              const wchar_t *root, unsigned long *error) {
  *error = 0;
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) {
    *error = GetLastError();
    return nullptr;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    *error = GetLastError();
    CloseHandle(job);
    return nullptr;
  }
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
  std::vector<unsigned char> storage(bytes);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(list, 1, 0, &bytes)) {
    *error = GetLastError();
    CloseHandle(job);
    return nullptr;
  }
  // Association happens inside CreateProcess, not in a crash-prone later Assign
  // call.
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job,
                                 sizeof(job), nullptr, nullptr)) {
    *error = GetLastError();
    DeleteProcThreadAttributeList(list);
    CloseHandle(job);
    return nullptr;
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = list;
  PROCESS_INFORMATION process{};
  auto command = quote(exe) + L" --pipe " + quote(pipe) + L" --token " +
                 quote(token) + L" --root " + quote(root);
  BOOL ok =
      CreateProcessW(exe, command.data(), nullptr, nullptr, FALSE,
                     EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                     nullptr, nullptr, &startup.StartupInfo, &process);
  if (!ok)
    *error = GetLastError();
  DeleteProcThreadAttributeList(list);
  if (!ok) {
    CloseHandle(job);
    return nullptr;
  }
  CloseHandle(process.hThread);
  return new CaptureJob{job, process.hProcess, process.dwProcessId};
}
extern "C" __declspec(dllexport) int __cdecl CaptureRunning(void *handle) {
  return handle &&
         WaitForSingleObject(static_cast<CaptureJob *>(handle)->process, 0) ==
             WAIT_TIMEOUT;
}
extern "C" __declspec(dllexport) unsigned long __cdecl
CapturePid(void *handle) {
  return handle ? static_cast<CaptureJob *>(handle)->pid : 0;
}
extern "C" __declspec(dllexport) void __cdecl
CaptureAllowForeground(void *handle) {
  if (handle)
    AllowSetForegroundWindow(static_cast<CaptureJob *>(handle)->pid);
}
extern "C" __declspec(dllexport) void __cdecl CaptureClose(void *handle) {
  if (!handle)
    return;
  auto owned = static_cast<CaptureJob *>(handle);
  CloseHandle(owned->job);
  CloseHandle(owned->process);
  delete owned;
}
