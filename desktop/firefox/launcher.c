#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int join(char *output, size_t capacity, const char *root, const char *suffix) {
  int written = snprintf(output, capacity, "%s%s", root, suffix);
  return written >= 0 && (size_t)written < capacity;
}

int main(void) {
  char executable[PATH_MAX], resolved[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0 || !realpath(executable, resolved)) return 1;
  char *separator = strrchr(resolved, '/');
  if (!separator) return 1;
  *separator = '\0';
  char firefox[PATH_MAX], node[PATH_MAX], script[PATH_MAX];
  if (!join(firefox, sizeof(firefox), resolved, "/firefox")) return 1;
  if (!join(node, sizeof(node), resolved, "/../Resources/obscura-desktop/bin/node")) return 1;
  if (!join(script, sizeof(script), resolved, "/../Resources/obscura-desktop/firefox/start.cjs")) return 1;
  setenv("OBSCURA_FIREFOX_BIN", firefox, 1);
  execl(node, node, script, (char *)NULL);
  perror("Obscura launcher");
  return 1;
}
