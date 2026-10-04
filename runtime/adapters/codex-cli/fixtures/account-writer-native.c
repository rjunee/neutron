#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <string.h>

/* Synthetic native writer: never reads credentials or accesses the network. */
int main(int argc, char **argv) {
  int held = 0, lifetime_fd = -1;
  char path[4096];
  struct stat expected, actual;
  snprintf(path, sizeof(path), "%s/.neutron-account-native.lock", getenv("CODEX_HOME"));
  int known = stat(path, &expected) == 0;
  for (int fd = 3; fd < 64; fd++) {
    if (known && fstat(fd, &actual) == 0 && actual.st_dev == expected.st_dev && actual.st_ino == expected.st_ino
        && fcntl(fd, F_GETFD) >= 0) {
      held++;
      lifetime_fd = fd;
    }
  }
  pid_t descendant = 0;
  if (argc > 1 && strcmp(argv[1], "--descendant") == 0) {
    descendant = fork();
    if (descendant < 0) return 2;
    if (descendant == 0) {
      close(0); close(1); close(2);
      execl("/bin/sleep", "sleep", "60", NULL);
      _exit(3);
    }
  }
  printf("{\"method\":\"fixture/ready\",\"pid\":%d,\"locks\":%d,\"lifetimeFd\":%d,\"descendant\":%d}\n", getpid(), held, lifetime_fd, descendant);
  fflush(stdout);
  for (;;) pause();
}
