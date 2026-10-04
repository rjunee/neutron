#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdlib.h>
#include <sys/stat.h>

/* Synthetic native writer: never reads credentials or accesses the network. */
int main(void) {
  int held = 0;
  char path[4096];
  struct stat expected, actual;
  snprintf(path, sizeof(path), "%s/.neutron-account-writer.lock", getenv("CODEX_HOME"));
  int known = stat(path, &expected) == 0;
  for (int fd = 3; fd < 64; fd++) {
    if (known && fstat(fd, &actual) == 0 && actual.st_dev == expected.st_dev && actual.st_ino == expected.st_ino
        && fcntl(fd, F_GETFD) >= 0) held++;
  }
  printf("{\"method\":\"fixture/ready\",\"pid\":%d,\"locks\":%d}\n", getpid(), held);
  fflush(stdout);
  for (;;) pause();
}
