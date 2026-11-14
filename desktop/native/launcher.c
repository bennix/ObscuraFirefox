#include <arpa/inet.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(int argc, char **argv) {
    char executable[PATH_MAX], bundle[PATH_MAX], engine[PATH_MAX], application[PATH_MAX];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) != 0 || !realpath(executable, bundle)) return 1;
    char *contents = strstr(bundle, "/Contents/MacOS/");
    if (!contents) return 1;
    *contents = '\0';
    snprintf(engine, sizeof(engine), "%s/Contents/MacOS/nwjs", bundle);
    snprintf(application, sizeof(application), "%s/Contents/Resources/app.nw", bundle);
    if (chdir(application) != 0) return 1;
    int descriptor = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(descriptor, (struct sockaddr *)&address, sizeof(address)) != 0) return 1;
    socklen_t length = sizeof(address);
    if (getsockname(descriptor, (struct sockaddr *)&address, &length) != 0) return 1;
    char port[16], debug[80], profile[PATH_MAX + 40], directory[PATH_MAX];
    snprintf(port, sizeof(port), "%u", ntohs(address.sin_port));
    close(descriptor);
    snprintf(directory, sizeof(directory), "%s/Library/Application Support/Obscura Desktop", getenv("HOME"));
    snprintf(profile, sizeof(profile), "--user-data-dir=%s/nw-profile", directory);
    snprintf(debug, sizeof(debug), "--remote-debugging-port=%s", port);
    setenv("OBSCURA_DEBUG_PORT", port, 1);
    setenv("OBSCURA_DATA_DIR", directory, 1);
    char *arguments[] = {engine, debug, profile, "--remote-debugging-address=127.0.0.1",
        "--disable-quic", "--disable-features=TrackingProtection3pcd,ThirdPartyCookieDeprecationTrial", "--no-first-run", NULL};
    execv(engine, arguments);
    perror("Obscura Desktop");
    return 1;
}
