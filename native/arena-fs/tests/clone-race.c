#define _DARWIN_C_SOURCE 1
#define _GNU_SOURCE 1

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int arena_fs_main(int argc, char **argv);
static ssize_t arena_test_read(int descriptor, void *buffer, size_t length);

#define read arena_test_read
#define main arena_fs_main
#ifndef ARENA_FS_SOURCE
#define ARENA_FS_SOURCE "../arena-fs.c"
#endif
#include ARENA_FS_SOURCE
#undef main
#undef read

static bool replacement_installed;

static int install_replacement_directory(void) {
    const char *parent = getenv("ARENA_TEST_CLONE_PARENT");
    if (parent == NULL) return 0;

    DIR *directory = opendir(parent);
    if (directory == NULL) return errno;
    char temporary[NAME_MAX + 1U];
    bool found = false;
    errno = 0;
    for (;;) {
        struct dirent *entry = readdir(directory);
        if (entry == NULL) break;
        if (strncmp(entry->d_name, ".arena-clone-", sizeof(".arena-clone-") - 1U) != 0) continue;
        size_t name_length = strlen(entry->d_name);
        if (name_length >= sizeof(temporary)) {
            closedir(directory);
            return ENAMETOOLONG;
        }
        memcpy(temporary, entry->d_name, name_length + 1U);
        found = true;
        break;
    }
    int error = errno;
    if (closedir(directory) != 0 && error == 0) error = errno;
    if (error != 0) return error;
    if (!found) return ENOENT;

    char temporary_path[PATH_MAX];
    int path_length = snprintf(temporary_path, sizeof(temporary_path), "%s/%s", parent, temporary);
    if (path_length < 0 || (size_t)path_length >= sizeof(temporary_path)) return ENAMETOOLONG;
    char displaced_path[PATH_MAX];
    path_length = snprintf(displaced_path, sizeof(displaced_path), "%s.displaced", temporary_path);
    if (path_length < 0 || (size_t)path_length >= sizeof(displaced_path)) return ENAMETOOLONG;
    if (rename(temporary_path, displaced_path) != 0) return errno;
    if (mkdir(temporary_path, 0700) != 0) return errno;

    char sentinel_path[PATH_MAX];
    path_length = snprintf(sentinel_path, sizeof(sentinel_path), "%s/attacker-sentinel", temporary_path);
    if (path_length < 0 || (size_t)path_length >= sizeof(sentinel_path)) return ENAMETOOLONG;
    int sentinel = openat(AT_FDCWD, sentinel_path,
                          O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (sentinel < 0) return errno;
    static const unsigned char contents[] = "replacement directory";
    size_t offset = 0;
    while (offset < sizeof(contents) - 1U) {
        ssize_t amount = write(sentinel, contents + offset, sizeof(contents) - 1U - offset);
        if (amount < 0) {
            error = errno;
            close(sentinel);
            return error;
        }
        if (amount == 0) {
            close(sentinel);
            return EIO;
        }
        offset += (size_t)amount;
    }
    if (close(sentinel) != 0) return errno;
    return 0;
}

static ssize_t arena_test_read(int descriptor, void *buffer, size_t length) {
    ssize_t amount = read(descriptor, buffer, length);
    if (descriptor == STDIN_FILENO && amount == 0 && !replacement_installed &&
        getenv("ARENA_TEST_CLONE_PARENT") != NULL) {
        int error = install_replacement_directory();
        if (error != 0) {
            errno = error;
            return -1;
        }
        replacement_installed = true;
    }
    return amount;
}

int main(int argc, char **argv) {
    return arena_fs_main(argc, argv);
}
