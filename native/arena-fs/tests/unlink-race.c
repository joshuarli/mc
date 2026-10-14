#define _DARWIN_C_SOURCE 1
#define _GNU_SOURCE 1

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int arena_fs_main(int argc, char **argv);
static int arena_test_unlinkat(int directory_fd, const char *path, int flags);

#define unlinkat arena_test_unlinkat
#define main arena_fs_main
#ifndef ARENA_FS_SOURCE
#define ARENA_FS_SOURCE "../arena-fs.c"
#endif
#include ARENA_FS_SOURCE
#undef main
#undef unlinkat

static bool replacement_installed;

static int arena_test_unlinkat(int directory_fd, const char *path, int flags) {
    if (!replacement_installed) {
        const char *leaf = getenv("ARENA_TEST_UNLINK_LEAF");
        const char *backup = getenv("ARENA_TEST_UNLINK_BACKUP");
        if (leaf != NULL && backup != NULL) {
            struct stat current;
            if (fstatat(directory_fd, leaf, &current, AT_SYMLINK_NOFOLLOW) == 0) {
                if (renameat(directory_fd, leaf, directory_fd, backup) != 0) return -1;
            } else if (errno != ENOENT) {
                return -1;
            }

            int replacement_fd = openat(directory_fd, leaf,
                                        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
            if (replacement_fd < 0) return -1;
            static const unsigned char replacement[] = "replacement survives";
            size_t offset = 0;
            while (offset < sizeof(replacement) - 1U) {
                ssize_t amount = write(replacement_fd, replacement + offset,
                                       sizeof(replacement) - 1U - offset);
                if (amount < 0) {
                    int error = errno;
                    close(replacement_fd);
                    errno = error;
                    return -1;
                }
                if (amount == 0) {
                    close(replacement_fd);
                    errno = EIO;
                    return -1;
                }
                offset += (size_t)amount;
            }
            if (close(replacement_fd) != 0) return -1;
            replacement_installed = true;
        }
    }
    return unlinkat(directory_fd, path, flags);
}

int main(int argc, char **argv) {
    return arena_fs_main(argc, argv);
}
