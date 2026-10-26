// Busyboy Computer Use: runs the Cua driver under this app's own macOS
// privacy permissions instead of Busyboy's.
//
// macOS charges a process's use of Accessibility and Screen Recording to the
// app responsible for it, and an app's children inherit that. If the driver
// used Busyboy's grants, so could every agent Busyboy starts, without asking
// the user. This app takes responsibility for itself, so the user grants these
// permissions to it alone and agents inherit nothing.
//
// It starts only for a Busyboy app, never inside a sandbox, and only runs the
// Cua-signed driver installed beside it. A sandbox passes to every process an
// agent starts, so an agent in one (such as Codex's default mode) cannot use
// this app by any route. An agent with full access is not contained: it can
// change Busyboy itself, which runs from user-writable source.
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
// Private in libsystem; Chromium uses it the same way.
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);
// Private in libsystem; with no operation it reports whether pid is sandboxed.
int sandbox_check(pid_t pid, const char *operation, int type, ...);

#define OWN_BUNDLE_ID "dev.jiwon.busyboy.computer-use"
#define CALLER_BUNDLE_ID "dev.jiwon.busyboy"
#define DISCLAIMED_ENV "BUSYBOY_COMPUTER_USE_DISCLAIMED"
#define REQUEST_PERMISSIONS "--request-permissions"
// Cua's Developer ID team.
#define DRIVER_REQUIREMENT \
  "anchor apple generic and certificate leaf[subject.OU] = \"YCK386LBJ7\""

static int fail(int status, const char *message) {
  fprintf(stderr, "Busyboy Computer Use: %s\n", message);
  return status;
}

// The bundle id of the app whose executable is at `path`, or NULL.
static CFStringRef copy_app_bundle_id(const char *path) {
  const char *marker = ".app/Contents/MacOS/";
  const char *found = NULL;
  for (const char *at = strstr(path, marker); at != NULL; at = strstr(at + 1, marker)) {
    found = at;
  }
  if (found == NULL) return NULL;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(
      NULL, (const UInt8 *)path, (CFIndex)(found + strlen(".app") - path), true);
  if (url == NULL) return NULL;
  CFBundleRef bundle = CFBundleCreate(NULL, url);
  CFRelease(url);
  if (bundle == NULL) return NULL;
  CFStringRef id = CFBundleGetIdentifier(bundle);
  if (id != NULL) CFRetain(id);
  CFRelease(bundle);
  return id;
}

// Busyboy's own processes (including the dev app) may start this; anything
// else, such as an agent's shell, may not.
static bool started_by_busyboy(void) {
  char path[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath(getppid(), path, sizeof path) <= 0) return false;
  CFStringRef id = copy_app_bundle_id(path);
  if (id == NULL) return false;
  bool ok = !CFEqual(id, CFSTR(OWN_BUNDLE_ID)) &&
            (CFEqual(id, CFSTR(CALLER_BUNDLE_ID)) ||
             CFStringHasPrefix(id, CFSTR(CALLER_BUNDLE_ID ".")));
  CFRelease(id);
  return ok;
}

// <resources>/computer-use/Busyboy Computer Use.app/Contents/MacOS/<exe>
// runs <resources>/cua-driver/cua-driver.
static bool find_driver(char *driver, size_t size) {
  char self[PATH_MAX];
  uint32_t self_size = sizeof self;
  char resolved[PATH_MAX];
  if (_NSGetExecutablePath(self, &self_size) != 0 || realpath(self, resolved) == NULL) {
    return false;
  }
  for (int up = 0; up < 5; up++) {
    char *slash = strrchr(resolved, '/');
    if (slash == NULL || slash == resolved) return false;
    *slash = '\0';
  }
  return snprintf(driver, size, "%s/cua-driver/cua-driver", resolved) < (int)size;
}

static bool driver_signed_by_cua(const char *driver) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(
      NULL, (const UInt8 *)driver, (CFIndex)strlen(driver), false);
  SecStaticCodeRef code = NULL;
  SecRequirementRef requirement = NULL;
  bool ok = url != NULL &&
            SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess &&
            SecRequirementCreateWithString(CFSTR(DRIVER_REQUIREMENT), kSecCSDefaultFlags,
                                           &requirement) == errSecSuccess &&
            SecStaticCodeCheckValidity(code, kSecCSCheckAllArchitectures, requirement) ==
                errSecSuccess;
  if (requirement != NULL) CFRelease(requirement);
  if (code != NULL) CFRelease(code);
  if (url != NULL) CFRelease(url);
  return ok;
}

// Replaces this process with itself, now responsible for its own permissions.
// The pid and stdio stay the same.
static int become_responsible(char *argv[]) {
  char self[PATH_MAX];
  uint32_t size = sizeof self;
  if (_NSGetExecutablePath(self, &size) != 0) return fail(70, "cannot find itself");
  setenv(DISCLAIMED_ENV, "1", 1);
  posix_spawnattr_t attrs;
  int error = posix_spawnattr_init(&attrs);
  if (error == 0) error = posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETEXEC);
  if (error == 0) error = responsibility_spawnattrs_setdisclaim(&attrs, 1);
  if (error == 0) error = posix_spawn(NULL, self, NULL, &attrs, argv, environ);
  fprintf(stderr, "Busyboy Computer Use: cannot take its own permissions: %s\n", strerror(error));
  return 71;
}

// Lists this app in System Settings and shows macOS's own prompts.
static int request_permissions(void) {
  const void *keys[] = {kAXTrustedCheckOptionPrompt};
  const void *values[] = {kCFBooleanTrue};
  CFDictionaryRef options =
      CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                         &kCFTypeDictionaryValueCallBacks);
  bool accessibility = AXIsProcessTrustedWithOptions(options);
  CFRelease(options);
  bool screen_recording = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess();
  printf("{\"accessibility\":%s,\"screenRecording\":%s}\n", accessibility ? "true" : "false",
         screen_recording ? "true" : "false");
  return 0;
}

static pid_t driver_pid = 0;

static void forward_signal(int signal) {
  if (driver_pid > 0) kill(driver_pid, signal);
}

static int run_driver(const char *driver, int argc, char *argv[]) {
  char **driver_argv = calloc((size_t)argc + 1, sizeof *driver_argv);
  if (driver_argv == NULL) return fail(70, "out of memory");
  driver_argv[0] = (char *)driver;
  for (int i = 1; i < argc; i++) driver_argv[i] = argv[i];

  struct sigaction action = {0};
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);

  // The driver is a child, so it inherits this app's responsibility.
  int error = posix_spawn(&driver_pid, driver, NULL, NULL, driver_argv, environ);
  free(driver_argv);
  if (error != 0) {
    fprintf(stderr, "Busyboy Computer Use: cannot start the driver: %s\n", strerror(error));
    return 127;
  }
  int status = 0;
  while (waitpid(driver_pid, &status, 0) < 0) {
    if (errno != EINTR) return fail(70, "lost the driver");
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

int main(int argc, char *argv[]) {
  // Busyboy's backend is never sandboxed; a sandboxed agent's processes always are.
  if (sandbox_check(getpid(), NULL, 0) != 0) {
    return fail(77, "computer use does not run inside a sandbox");
  }
  if (!started_by_busyboy()) return fail(77, "only Busyboy can start computer use");
  if (getenv(DISCLAIMED_ENV) == NULL) return become_responsible(argv);
  unsetenv(DISCLAIMED_ENV);

  if (argc == 2 && strcmp(argv[1], REQUEST_PERMISSIONS) == 0) return request_permissions();

  char driver[PATH_MAX];
  if (!find_driver(driver, sizeof driver)) return fail(70, "cannot find the driver");
  if (!driver_signed_by_cua(driver)) {
    return fail(77, "the driver beside this app is missing or not signed by Cua");
  }
  return run_driver(driver, argc, argv);
}
