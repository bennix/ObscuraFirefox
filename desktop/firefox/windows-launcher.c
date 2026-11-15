#define UNICODE
#define _UNICODE
#include <windows.h>
#include <wchar.h>
#include <shellapi.h>
#pragma comment(lib, "shell32.lib")
int main(void) {
  wchar_t root[32768], node[32768], script[32768], command[65536], profile[32768];
  if (!GetModuleFileNameW(NULL, root, 32768)) return 1;
  wchar_t *slash = wcsrchr(root, L'\\'); if (!slash) return 1; *slash = 0;
#ifdef NATIVE_HOST
  _snwprintf(node,32768,L"%ls\\node.exe",root);
  _snwprintf(script,32768,L"%ls\\..\\firefox\\native-host.cjs",root);
  int argc=0; wchar_t **argv=CommandLineToArgvW(GetCommandLineW(),&argc);
  if (!argv || argc<2) return 1;
  wcsncpy(profile,argv[1],32767);profile[32767]=0;LocalFree(argv);
  wchar_t *parent=wcsrchr(profile,L'\\');if(!parent)return 1;*parent=0;
  parent=wcsrchr(profile,L'\\');if(!parent)return 1;*parent=0;
  _snwprintf(command,65536,L"\"%ls\" \"%ls\" \"%ls\"",node,script,profile);
#else
  wchar_t firefox[32768];
  _snwprintf(node,32768,L"%ls\\obscura-desktop\\bin\\node.exe",root);
  _snwprintf(script,32768,L"%ls\\obscura-desktop\\firefox\\start.cjs",root);
  _snwprintf(firefox,32768,L"%ls\\firefox.exe",root);
  SetEnvironmentVariableW(L"OBSCURA_FIREFOX_BIN",firefox);
  _snwprintf(command,65536,L"\"%ls\" \"%ls\"",node,script);
#endif
  STARTUPINFOW si={0}; PROCESS_INFORMATION pi={0}; si.cb=sizeof(si);
#ifdef NATIVE_HOST
  si.dwFlags=STARTF_USESTDHANDLES;
  si.hStdInput=GetStdHandle(STD_INPUT_HANDLE);si.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);si.hStdError=GetStdHandle(STD_ERROR_HANDLE);
#endif
  if (!CreateProcessW(node,command,NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi)) return 1;
  WaitForSingleObject(pi.hProcess,INFINITE);DWORD code=1;GetExitCodeProcess(pi.hProcess,&code);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);return (int)code;
}
