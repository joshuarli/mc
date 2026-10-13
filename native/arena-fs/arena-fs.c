#define _DARWIN_C_SOURCE 1
#define _GNU_SOURCE 1

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

extern char **environ;

#if defined(__APPLE__) && defined(__MACH__) && (defined(__arm64__) || defined(__aarch64__))
#include <stdlib.h>
#define ARENA_SUPPORTED_HOST 1
#elif defined(__linux__) && defined(__x86_64__)
#include <sys/random.h>
#define ARENA_SUPPORTED_HOST 1
#else
#error "arena-fs supports only Darwin arm64 and Linux x86_64"
#endif

#define MAX_PLAN_BYTES (128U * 1024U * 1024U)
#define MAX_READ_BYTES (16U * 1024U * 1024U)
#define MAX_PATH_BYTES 4096U
#define MAX_PATH_COMPONENTS 128U
#define MAX_RAW_ARGV_COUNT 4096U
#define MAX_RAW_ARGV_BYTES (48U * 1024U)
#define MAX_RAW_ARGV_CHANNEL_BYTES (64U * 1024U)
#define RAW_ARGV_ENV "ARENA_RAW_ARGV_V1="

static volatile sig_atomic_t cancellation_requested = 0;

struct fs_error {
    int code;
    int cleanup_code;
    bool published;
    dev_t device;
    ino_t inode;
};

struct created_directory {
    int parent_fd;
    char *name;
    dev_t device;
    ino_t inode;
};

static void on_signal(int signal_number) {
    (void)signal_number;
    cancellation_requested = 1;
}

static int install_signal_handlers(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_signal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0) {
        return errno;
    }

    struct sigaction ignore_pipe;
    memset(&ignore_pipe, 0, sizeof(ignore_pipe));
    ignore_pipe.sa_handler = SIG_IGN;
    sigemptyset(&ignore_pipe.sa_mask);
    if (sigaction(SIGPIPE, &ignore_pipe, NULL) != 0) {
        return errno;
    }
    return 0;
}

static bool cancelled(void) {
    return cancellation_requested != 0;
}

static int write_all(int fd, const unsigned char *bytes, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        if (cancelled()) return ECANCELED;
        ssize_t written = write(fd, bytes + offset, length - offset);
        if (written < 0) {
            if (errno == EINTR && cancelled()) return ECANCELED;
            if (errno == EINTR) continue;
            return errno;
        }
        if (written == 0) return EIO;
        offset += (size_t)written;
    }
    return 0;
}

static int read_bounded_stdin(int output_fd, uint64_t limit) {
    unsigned char buffer[16384];
    uint64_t total = 0;
    for (;;) {
        if (cancelled()) return ECANCELED;
        ssize_t amount = read(STDIN_FILENO, buffer, sizeof(buffer));
        if (amount < 0) {
            if (errno == EINTR && cancelled()) return ECANCELED;
            if (errno == EINTR) continue;
            return errno;
        }
        if (amount == 0) return 0;
        if ((uint64_t)amount > limit - total) return EFBIG;
        int error = write_all(output_fd, buffer, (size_t)amount);
        if (error != 0) return error;
        total += (uint64_t)amount;
    }
}

static int base64_value(unsigned char byte) {
    if (byte >= 'A' && byte <= 'Z') return (int)(byte - 'A');
    if (byte >= 'a' && byte <= 'z') return (int)(byte - 'a') + 26;
    if (byte >= '0' && byte <= '9') return (int)(byte - '0') + 52;
    if (byte == '+') return 62;
    if (byte == '/') return 63;
    return -1;
}

static int decode_base64(const char *encoded, unsigned char **decoded, size_t *decoded_length) {
    size_t encoded_length = strlen(encoded);
    if (encoded_length % 4U != 0U) return EINVAL;
    if (encoded_length > SIZE_MAX / 3U) return EOVERFLOW;
    size_t capacity = (encoded_length / 4U) * 3U;
    unsigned char *output = malloc(capacity == 0 ? 1U : capacity);
    if (output == NULL) return ENOMEM;

    size_t output_length = 0;
    for (size_t index = 0; index < encoded_length; index += 4U) {
        int a = base64_value((unsigned char)encoded[index]);
        int b = base64_value((unsigned char)encoded[index + 1U]);
        bool pad_c = encoded[index + 2U] == '=';
        bool pad_d = encoded[index + 3U] == '=';
        int c = pad_c ? 0 : base64_value((unsigned char)encoded[index + 2U]);
        int d = pad_d ? 0 : base64_value((unsigned char)encoded[index + 3U]);
        bool last = index + 4U == encoded_length;
        if (a < 0 || b < 0 || c < 0 || d < 0 || (pad_c && !pad_d) || ((pad_c || pad_d) && !last)) {
            free(output);
            return EINVAL;
        }
        if (pad_c && (b & 15) != 0) {
            free(output);
            return EINVAL;
        }
        if (pad_d && !pad_c && (c & 3) != 0) {
            free(output);
            return EINVAL;
        }
        uint32_t combined = ((uint32_t)a << 18U) | ((uint32_t)b << 12U) |
                            ((uint32_t)c << 6U) | (uint32_t)d;
        output[output_length++] = (unsigned char)((combined >> 16U) & 0xffU);
        if (!pad_c) output[output_length++] = (unsigned char)((combined >> 8U) & 0xffU);
        if (!pad_d) output[output_length++] = (unsigned char)(combined & 0xffU);
    }
    *decoded = output;
    *decoded_length = output_length;
    return 0;
}

static int decode_path_argument(const char *encoded, char **path, size_t *path_length) {
    unsigned char *decoded = NULL;
    size_t length = 0;
    int error = decode_base64(encoded, &decoded, &length);
    if (error != 0) return error;
    if (length == 0 || length > MAX_PATH_BYTES || memchr(decoded, '\0', length) != NULL) {
        free(decoded);
        return length > MAX_PATH_BYTES ? ENAMETOOLONG : EINVAL;
    }
    char *terminated = realloc(decoded, length + 1U);
    if (terminated == NULL) {
        free(decoded);
        return ENOMEM;
    }
    terminated[length] = '\0';
    *path = terminated;
    *path_length = length;
    return 0;
}

static bool component_is_invalid(const char *component, size_t length) {
    return length == 0 || (length == 1 && component[0] == '.') ||
           (length == 2 && component[0] == '.' && component[1] == '.');
}

static int validate_existing_parent(int fd);

/* Darwin can report ENOTDIR for a symlink opened with O_NOFOLLOW|O_DIRECTORY. */
static int open_directory_at(int parent_fd, const char *component) {
    int fd = openat(parent_fd, component,
                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd >= 0) return fd;
    int error = errno;
    if (error == ENOTDIR || error == ELOOP) {
        struct stat status;
        if (fstatat(parent_fd, component, &status, AT_SYMLINK_NOFOLLOW) == 0 &&
            S_ISLNK(status.st_mode)) {
            error = ELOOP;
        }
    }
    return -error;
}

/* Resolve each canonical root component once, rejecting links before anchoring relative work. */
static int open_absolute_directory(const char *path) {
    if (path[0] != '/') return EINVAL;
    if (strcmp(path, "/") == 0) {
        int root_fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        return root_fd < 0 ? -errno : root_fd;
    }

    int current_fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (current_fd < 0) return -errno;
    size_t path_length = strlen(path);
    if (path_length > MAX_PATH_BYTES || path[path_length - 1U] == '/') {
        close(current_fd);
        return -ENAMETOOLONG;
    }

    size_t offset = 1U;
    while (offset < path_length) {
        size_t end = offset;
        while (end < path_length && path[end] != '/') end++;
        size_t component_length = end - offset;
        if (component_is_invalid(path + offset, component_length)) {
            close(current_fd);
            return -EINVAL;
        }
        char component[NAME_MAX + 1U];
        if (component_length > NAME_MAX) {
            close(current_fd);
            return -ENAMETOOLONG;
        }
        memcpy(component, path + offset, component_length);
        component[component_length] = '\0';
        int next_fd = open_directory_at(current_fd, component);
        if (next_fd < 0) {
            int error = -next_fd;
            close(current_fd);
            return -error;
        }
        if (close(current_fd) != 0) {
            int error = errno;
            close(next_fd);
            return -error;
        }
        current_fd = next_fd;
        offset = end + 1U;
    }
    return current_fd;
}

static int open_owned_root(const char *path) {
    int root_fd = open_absolute_directory(path);
    if (root_fd < 0) return -root_fd;
    struct stat status;
    if (fstat(root_fd, &status) != 0) {
        int error = errno;
        close(root_fd);
        return error;
    }
    if (!S_ISDIR(status.st_mode)) {
        close(root_fd);
        return ENOTDIR;
    }
    int error = validate_existing_parent(root_fd);
    if (error != 0) {
        close(root_fd);
        return error;
    }
    return root_fd;
}

static int check_relative_path(const char *path, size_t length) {
    if (length == 0 || path[0] == '/' || path[length - 1U] == '/') return EINVAL;
    size_t component_count = 0;
    size_t start = 0;
    for (size_t index = 0; index <= length; index++) {
        if (index != length && path[index] != '/') continue;
        size_t component_length = index - start;
        if (component_is_invalid(path + start, component_length)) return EINVAL;
        if (component_length > NAME_MAX) return ENAMETOOLONG;
        component_count++;
        if (component_count > MAX_PATH_COMPONENTS) return E2BIG;
        start = index + 1U;
    }
    return 0;
}

static int open_relative_parent(int root_fd, const char *path, size_t length,
                                int *parent_fd, char **leaf) {
    int error = check_relative_path(path, length);
    if (error != 0) return error;
    size_t leaf_start = length;
    while (leaf_start > 0 && path[leaf_start - 1U] != '/') leaf_start--;
    size_t leaf_length = length - leaf_start;
    char *leaf_name = malloc(leaf_length + 1U);
    if (leaf_name == NULL) return ENOMEM;
    memcpy(leaf_name, path + leaf_start, leaf_length);
    leaf_name[leaf_length] = '\0';

    int current_fd = dup(root_fd);
    if (current_fd < 0) {
        error = errno;
        free(leaf_name);
        return error;
    }
    size_t offset = 0;
    size_t parent_end = leaf_start == 0 ? 0 : leaf_start - 1U;
    while (offset < parent_end) {
        size_t end = offset;
        while (end < parent_end && path[end] != '/') end++;
        size_t component_length = end - offset;
        char component[NAME_MAX + 1U];
        memcpy(component, path + offset, component_length);
        component[component_length] = '\0';
        int next_fd = open_directory_at(current_fd, component);
        if (next_fd < 0) {
            error = -next_fd;
            close(current_fd);
            free(leaf_name);
            return error;
        }
        error = validate_existing_parent(next_fd);
        if (error != 0) {
            close(current_fd);
            close(next_fd);
            free(leaf_name);
            return error;
        }
        if (close(current_fd) != 0) {
            error = errno;
            close(next_fd);
            free(leaf_name);
            return error;
        }
        current_fd = next_fd;
        offset = end + 1U;
    }
    *parent_fd = current_fd;
    *leaf = leaf_name;
    return 0;
}

static const char *error_category(int error) {
    if (error == EINVAL || error == ENAMETOOLONG || error == E2BIG || error == ENOTDIR) return "invalid_path";
    if (error == EEXIST || error == ENOTEMPTY || error == ESTALE) return "conflict";
    if (error == EACCES || error == EPERM || error == EROFS) return "permission";
    if (error == ELOOP) return "symlink_rejected";
    if (error == ENOENT) return "not_found";
    if (error == EFBIG) return "too_large";
    if (error == ECANCELED) return "cancelled";
    if (error == ENOTSUP || error == EOPNOTSUPP) return "unsupported_file_type";
    return "io";
}

static void print_success(const char *operation, const struct stat *status) {
    printf("{\"v\":1,\"ok\":true,\"operation\":\"%s\",\"device\":\"%ju\",\"inode\":\"%ju\"}\n",
           operation, (uintmax_t)status->st_dev, (uintmax_t)status->st_ino);
    fflush(stdout);
}

static int base64_encoded_length(size_t length, size_t *encoded_length);
static void encode_base64(const unsigned char *input, size_t length, char *output);

static int print_created_event(const char *event, const char *relative_path, size_t path_length,
                               const struct stat *status) {
    size_t encoded_length = 0;
    int error = base64_encoded_length(path_length, &encoded_length);
    if (error != 0) return error;
    char *encoded_path = malloc(encoded_length + 1U);
    if (encoded_path == NULL) return ENOMEM;
    encode_base64((const unsigned char *)relative_path, path_length, encoded_path);
    if (printf("{\"v\":1,\"event\":\"%s\",\"path\":\"%s\",\"device\":\"%ju\",\"inode\":\"%ju\"}\n",
               event, encoded_path, (uintmax_t)status->st_dev, (uintmax_t)status->st_ino) < 0 ||
        fflush(stdout) != 0) {
        error = errno == 0 ? EIO : errno;
    }
    free(encoded_path);
    return error;
}

static void print_error(const char *operation, const struct fs_error *error) {
    printf("{\"v\":1,\"ok\":false,\"operation\":\"%s\",\"category\":\"%s\",\"errno\":%d,\"cleanup_errno\":%d,\"published\":%s,\"device\":\"%ju\",\"inode\":\"%ju\"}\n",
           operation, error_category(error->code), error->code, error->cleanup_code,
           error->published ? "true" : "false", (uintmax_t)error->device,
           (uintmax_t)error->inode);
    fflush(stdout);
}

static void print_read_success(const unsigned char *bytes, size_t length) {
    size_t encoded_length = 0;
    if (base64_encoded_length(length, &encoded_length) != 0) {
        struct fs_error failure = {.code = EOVERFLOW};
        print_error("read-owned-file", &failure);
        return;
    }
    char *encoded = malloc(encoded_length + 1U);
    if (encoded == NULL) {
        struct fs_error failure = {.code = ENOMEM};
        print_error("read-owned-file", &failure);
        return;
    }
    encode_base64(bytes, length, encoded);
    printf("{\"v\":1,\"ok\":true,\"operation\":\"read-owned-file\",\"data\":\"%s\"}\n",
           encoded);
    fflush(stdout);
    free(encoded);
}

static int sync_directory(int fd) {
    if (fsync(fd) == 0) return 0;
    return errno;
}

static int random_bytes(unsigned char *buffer, size_t length) {
#if defined(__APPLE__)
    arc4random_buf(buffer, length);
    return 0;
#elif defined(__linux__)
    size_t offset = 0;
    while (offset < length) {
        ssize_t amount = getrandom(buffer + offset, length - offset, 0);
        if (amount < 0) {
            if (errno == EINTR) continue;
            return errno;
        }
        if (amount == 0) return EIO;
        offset += (size_t)amount;
    }
    return 0;
#endif
}

static int identity_at(int parent_fd, const char *name, dev_t device, ino_t inode,
                       bool directory, struct stat *found) {
    if (fstatat(parent_fd, name, found, AT_SYMLINK_NOFOLLOW) != 0) return errno;
    if ((directory && !S_ISDIR(found->st_mode)) || (!directory && !S_ISREG(found->st_mode))) return EINVAL;
    if (found->st_dev != device || found->st_ino != inode) return ESTALE;
    return 0;
}

static int unlink_if_identity(int parent_fd, const char *name, dev_t device, ino_t inode,
                              bool directory) {
    struct stat found;
    int error = identity_at(parent_fd, name, device, inode, directory, &found);
    if (error != 0) return error;
    if (unlinkat(parent_fd, name, directory ? AT_REMOVEDIR : 0) != 0) return errno;
    return sync_directory(parent_fd);
}

static void cleanup_created_directories(struct created_directory *created, size_t count,
                                        struct fs_error *error) {
    for (size_t index = count; index > 0; index--) {
        struct created_directory *directory = &created[index - 1U];
        int cleanup_error = unlink_if_identity(directory->parent_fd, directory->name,
                                               directory->device, directory->inode, true);
        if (cleanup_error != 0 && error->cleanup_code == 0) error->cleanup_code = cleanup_error;
        close(directory->parent_fd);
        free(directory->name);
    }
}

static void close_created_directories(struct created_directory *created, size_t count) {
    for (size_t index = 0; index < count; index++) {
        close(created[index].parent_fd);
        free(created[index].name);
    }
}

static int remember_created_directory(struct created_directory *created, size_t *count,
                                      int parent_fd, const char *name, const struct stat *status) {
    int parent_copy = dup(parent_fd);
    if (parent_copy < 0) return errno;
    char *name_copy = strdup(name);
    if (name_copy == NULL) {
        int error = errno;
        close(parent_copy);
        return error == 0 ? ENOMEM : error;
    }
    created[*count].parent_fd = parent_copy;
    created[*count].name = name_copy;
    created[*count].device = status->st_dev;
    created[*count].inode = status->st_ino;
    (*count)++;
    return 0;
}

static int validate_existing_parent(int fd) {
    struct stat status;
    if (fstat(fd, &status) != 0) return errno;
    if (!S_ISDIR(status.st_mode)) return ENOTDIR;
    if ((status.st_mode & (S_IWGRP | S_IWOTH)) != 0) return EACCES;
    if (status.st_uid != geteuid() && status.st_uid != 0) return EACCES;
    return 0;
}

/* Create only the final run leaf; missing ancestors are private and removed on failure. */
static int create_run_directory(const char *root, const char *relative, size_t relative_length,
                                struct fs_error *failure, struct stat *created_status) {
    struct created_directory created[MAX_PATH_COMPONENTS];
    memset(created, 0, sizeof(created));
    size_t created_count = 0;
    int root_fd = open_owned_root(root);
    if (root_fd < 0) {
        failure->code = -root_fd;
        return failure->code;
    }
    int error = check_relative_path(relative, relative_length);
    if (error != 0) {
        close(root_fd);
        failure->code = error;
        return error;
    }
    int current_fd = dup(root_fd);
    close(root_fd);
    if (current_fd < 0) {
        failure->code = errno;
        return failure->code;
    }

    size_t offset = 0;
    size_t component_index = 0;
    size_t component_total = 1;
    for (size_t index = 0; index < relative_length; index++) {
        if (relative[index] == '/') component_total++;
    }
    while (offset < relative_length) {
        if (cancelled()) {
            error = ECANCELED;
            goto fail;
        }
        size_t end = offset;
        while (end < relative_length && relative[end] != '/') end++;
        size_t component_length = end - offset;
        char component[NAME_MAX + 1U];
        memcpy(component, relative + offset, component_length);
        component[component_length] = '\0';
        bool final_component = component_index + 1U == component_total;
        int next_fd = -1;
        if (final_component) {
            if (mkdirat(current_fd, component, 0700) != 0) {
                error = errno;
                goto fail;
            }
            struct stat status;
            if (fstatat(current_fd, component, &status, AT_SYMLINK_NOFOLLOW) != 0) {
                error = errno;
                failure->cleanup_code = error;
                goto fail;
            }
            if (!S_ISDIR(status.st_mode)) {
                error = ESTALE;
                failure->cleanup_code = error;
                goto fail;
            }
            error = remember_created_directory(created, &created_count, current_fd, component, &status);
            if (error != 0) {
                int cleanup_error = unlink_if_identity(current_fd, component, status.st_dev,
                                                       status.st_ino, true);
                if (cleanup_error != 0) failure->cleanup_code = cleanup_error;
                goto fail;
            }
            next_fd = open_directory_at(current_fd, component);
            if (next_fd < 0) {
                error = -next_fd;
                goto fail;
            }
            struct stat opened_status;
            if (fstat(next_fd, &opened_status) != 0) {
                error = errno;
                close(next_fd);
                goto fail;
            }
            if (opened_status.st_dev != status.st_dev || opened_status.st_ino != status.st_ino ||
                !S_ISDIR(opened_status.st_mode)) {
                error = ESTALE;
                close(next_fd);
                goto fail;
            }
            error = print_created_event("created-directory", relative, end, &status);
            if (error != 0) {
                close(next_fd);
                goto fail;
            }
            error = sync_directory(next_fd);
            if (error == 0) error = sync_directory(current_fd);
            if (error != 0) {
                close(next_fd);
                goto fail;
            }
            *created_status = status;
        } else {
            next_fd = open_directory_at(current_fd, component);
            if (next_fd < 0 && -next_fd == ENOENT) {
                if (mkdirat(current_fd, component, 0700) != 0) {
                    error = errno;
                    goto fail;
                }
                struct stat status;
                if (fstatat(current_fd, component, &status, AT_SYMLINK_NOFOLLOW) != 0) {
                    error = errno;
                    failure->cleanup_code = error;
                    goto fail;
                }
                if (!S_ISDIR(status.st_mode)) {
                    error = ESTALE;
                    failure->cleanup_code = error;
                    goto fail;
                }
                error = remember_created_directory(created, &created_count, current_fd, component, &status);
                if (error != 0) {
                    int cleanup_error = unlink_if_identity(current_fd, component, status.st_dev,
                                                           status.st_ino, true);
                    if (cleanup_error != 0) failure->cleanup_code = cleanup_error;
                    goto fail;
                }
                next_fd = open_directory_at(current_fd, component);
                if (next_fd < 0) {
                    error = -next_fd;
                    goto fail;
                }
                struct stat opened_status;
                if (fstat(next_fd, &opened_status) != 0) {
                    error = errno;
                    close(next_fd);
                    goto fail;
                }
                if (opened_status.st_dev != status.st_dev || opened_status.st_ino != status.st_ino ||
                    !S_ISDIR(opened_status.st_mode)) {
                    error = ESTALE;
                    close(next_fd);
                    goto fail;
                }
                error = print_created_event("created-directory", relative, end, &status);
                if (error != 0) {
                    close(next_fd);
                    goto fail;
                }
                error = sync_directory(current_fd);
                if (error != 0) {
                    close(next_fd);
                    goto fail;
                }
            } else if (next_fd < 0) {
                error = -next_fd;
                goto fail;
            } else {
                error = validate_existing_parent(next_fd);
                if (error != 0) {
                    close(next_fd);
                    goto fail;
                }
            }
        }
        close(current_fd);
        current_fd = next_fd;
        component_index++;
        offset = end + 1U;
    }
    close(current_fd);
    close_created_directories(created, created_count);
    return 0;

fail:
    close(current_fd);
    failure->code = error;
    cleanup_created_directories(created, created_count, failure);
    return error;
}

static int create_random_temp_name(char *name, size_t capacity) {
    unsigned char random[16];
    int error = random_bytes(random, sizeof(random));
    if (error != 0) return error;
    static const char hex[] = "0123456789abcdef";
    const char prefix[] = ".arena-world-plan-";
    size_t needed = sizeof(prefix) - 1U + sizeof(random) * 2U + 1U;
    if (capacity < needed) return ENAMETOOLONG;
    memcpy(name, prefix, sizeof(prefix) - 1U);
    size_t offset = sizeof(prefix) - 1U;
    for (size_t index = 0; index < sizeof(random); index++) {
        name[offset++] = hex[(random[index] >> 4U) & 0xfU];
        name[offset++] = hex[random[index] & 0xfU];
    }
    name[offset] = '\0';
    return 0;
}

/* linkat publishes a fully synced same-directory temp without replacing an existing leaf. */
static int stage_world_plan(const char *root, const char *relative, size_t relative_length,
                            uint64_t caller_limit, struct fs_error *failure,
                            struct stat *published_status) {
    int root_fd = open_owned_root(root);
    if (root_fd < 0) {
        failure->code = -root_fd;
        return failure->code;
    }
    int parent_fd = -1;
    char *destination = NULL;
    int error = open_relative_parent(root_fd, relative, relative_length, &parent_fd, &destination);
    close(root_fd);
    if (error != 0) {
        failure->code = error;
        return error;
    }

    struct stat existing;
    if (fstatat(parent_fd, destination, &existing, AT_SYMLINK_NOFOLLOW) == 0) {
        error = EEXIST;
        goto done;
    }
    if (errno != ENOENT) {
        error = errno;
        goto done;
    }

    uint64_t limit = caller_limit < MAX_PLAN_BYTES ? caller_limit : MAX_PLAN_BYTES;
    char temporary[NAME_MAX + 1U];
    int temporary_fd = -1;
    for (unsigned int attempt = 0; attempt < 32U; attempt++) {
        if (cancelled()) {
            error = ECANCELED;
            goto done;
        }
        error = create_random_temp_name(temporary, sizeof(temporary));
        if (error != 0) goto done;
        temporary_fd = openat(parent_fd, temporary,
                              O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (temporary_fd >= 0) break;
        error = errno;
        if (error != EEXIST) goto done;
    }
    if (temporary_fd < 0) {
        error = EEXIST;
        goto done;
    }

    struct stat temporary_status;
    if (fstat(temporary_fd, &temporary_status) != 0) {
        error = errno;
        failure->cleanup_code = error;
        close(temporary_fd);
        temporary_fd = -1;
        goto done;
    }
    if (!S_ISREG(temporary_status.st_mode)) {
        error = EINVAL;
        goto cleanup_temporary;
    }
    size_t parent_length = 0;
    for (size_t index = 0; index < relative_length; index++) {
        if (relative[index] == '/') parent_length = index + 1U;
    }
    size_t temporary_path_length = parent_length + strlen(temporary);
    if (temporary_path_length > MAX_PATH_BYTES) {
        error = ENAMETOOLONG;
        goto cleanup_temporary;
    }
    char temporary_path[MAX_PATH_BYTES + 1U];
    memcpy(temporary_path, relative, parent_length);
    memcpy(temporary_path + parent_length, temporary, strlen(temporary));
    temporary_path[temporary_path_length] = '\0';
    error = print_created_event("staged-file", temporary_path, temporary_path_length,
                                &temporary_status);
    if (error != 0) goto cleanup_temporary;
    error = read_bounded_stdin(temporary_fd, limit);
    if (error != 0) goto cleanup_temporary;
    if (cancelled()) {
        error = ECANCELED;
        goto cleanup_temporary;
    }
    if (fsync(temporary_fd) != 0) {
        error = errno;
        goto cleanup_temporary;
    }
    if (close(temporary_fd) != 0) {
        temporary_fd = -1;
        error = errno;
        goto cleanup_temporary;
    }
    temporary_fd = -1;
    if (cancelled()) {
        error = ECANCELED;
        goto cleanup_temporary;
    }
    if (linkat(parent_fd, temporary, parent_fd, destination, 0) != 0) {
        error = errno;
        goto cleanup_temporary;
    }
    failure->published = true;
    failure->device = temporary_status.st_dev;
    failure->inode = temporary_status.st_ino;
    *published_status = temporary_status;

    if (unlinkat(parent_fd, temporary, 0) != 0) {
        error = errno;
        int cleanup_error = unlink_if_identity(parent_fd, destination, temporary_status.st_dev,
                                              temporary_status.st_ino, false);
        if (cleanup_error != 0) failure->cleanup_code = cleanup_error;
        failure->published = cleanup_error != 0;
        goto done;
    }
    if (cancelled()) {
        error = ECANCELED;
        int cleanup_error = unlink_if_identity(parent_fd, destination, temporary_status.st_dev,
                                              temporary_status.st_ino, false);
        if (cleanup_error != 0) failure->cleanup_code = cleanup_error;
        failure->published = cleanup_error != 0;
        goto done;
    }
    error = sync_directory(parent_fd);
    if (error != 0) {
        int cleanup_error = unlink_if_identity(parent_fd, destination, temporary_status.st_dev,
                                              temporary_status.st_ino, false);
        if (cleanup_error != 0) failure->cleanup_code = cleanup_error;
        failure->published = cleanup_error != 0;
        goto done;
    }
    failure->published = false;
    print_success("stage-world-plan", published_status);
    close(parent_fd);
    free(destination);
    return 0;

cleanup_temporary:
    if (temporary_fd >= 0 && close(temporary_fd) != 0 && failure->cleanup_code == 0) {
        failure->cleanup_code = errno;
    }
    {
        int cleanup_error = unlink_if_identity(parent_fd, temporary, temporary_status.st_dev,
                                              temporary_status.st_ino, false);
        if (cleanup_error != 0 && failure->cleanup_code == 0) failure->cleanup_code = cleanup_error;
    }
done:
    failure->code = error;
    close(parent_fd);
    free(destination);
    return error;
}

/* Refuse cleanup unless the leaf still names the regular file or empty directory we created. */
static int remove_created_entry(const char *root, const char *relative, size_t relative_length,
                                uintmax_t expected_device, uintmax_t expected_inode,
                                bool directory, struct fs_error *failure) {
    int root_fd = open_owned_root(root);
    if (root_fd < 0) {
        failure->code = -root_fd;
        return failure->code;
    }
    int parent_fd = -1;
    char *leaf = NULL;
    int error = open_relative_parent(root_fd, relative, relative_length, &parent_fd, &leaf);
    close(root_fd);
    if (error != 0) {
        failure->code = error;
        return error;
    }
    struct stat status;
    error = identity_at(parent_fd, leaf, (dev_t)expected_device, (ino_t)expected_inode,
                        directory, &status);
    if (error == 0) {
        if (cancelled()) {
            error = ECANCELED;
        } else if (unlinkat(parent_fd, leaf, directory ? AT_REMOVEDIR : 0) != 0) {
            error = errno;
        } else {
            error = sync_directory(parent_fd);
        }
    }
    close(parent_fd);
    free(leaf);
    if (error != 0) failure->code = error;
    return error;
}

/* Read through one opened regular-file handle and enforce the limit even if it grows. */
static int read_owned_file(const char *root, const char *relative, size_t relative_length,
                           uint64_t caller_limit, struct fs_error *failure,
                           unsigned char **contents, size_t *contents_length) {
    int root_fd = open_owned_root(root);
    if (root_fd < 0) {
        failure->code = -root_fd;
        return failure->code;
    }
    int parent_fd = -1;
    char *leaf = NULL;
    int error = open_relative_parent(root_fd, relative, relative_length, &parent_fd, &leaf);
    close(root_fd);
    if (error != 0) {
        failure->code = error;
        return error;
    }
    int file_fd = openat(parent_fd, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (file_fd < 0) {
        error = errno;
        goto done;
    }
    struct stat initial_status;
    if (fstat(file_fd, &initial_status) != 0) {
        error = errno;
        close(file_fd);
        goto done;
    }
    if (!S_ISREG(initial_status.st_mode)) {
        error = EOPNOTSUPP;
        close(file_fd);
        goto done;
    }
    uint64_t limit = caller_limit < MAX_READ_BYTES ? caller_limit : MAX_READ_BYTES;
    if (initial_status.st_size < 0 || (uint64_t)initial_status.st_size > limit) {
        error = EFBIG;
        close(file_fd);
        goto done;
    }
    size_t capacity = (size_t)limit + 1U;
    unsigned char *buffer = malloc(capacity == 0 ? 1U : capacity);
    if (buffer == NULL) {
        error = ENOMEM;
        close(file_fd);
        goto done;
    }
    size_t length = 0;
    while (length <= (size_t)limit) {
        if (cancelled()) {
            error = ECANCELED;
            break;
        }
        size_t remaining = capacity - length;
        if (remaining > 16384U) remaining = 16384U;
        ssize_t amount = read(file_fd, buffer + length, remaining);
        if (amount < 0) {
            if (errno == EINTR && cancelled()) {
                error = ECANCELED;
                break;
            }
            if (errno == EINTR) continue;
            error = errno;
            break;
        }
        if (amount == 0) break;
        length += (size_t)amount;
        if (length > (size_t)limit) {
            error = EFBIG;
            break;
        }
    }
    if (close(file_fd) != 0 && error == 0) error = errno;
    if (error != 0) {
        free(buffer);
        goto done;
    }
    *contents = buffer;
    *contents_length = length;

done:
    close(parent_fd);
    free(leaf);
    if (error != 0) failure->code = error;
    return error;
}

static int parse_u64(const char *text, uint64_t *value) {
    if (text[0] == '\0') return EINVAL;
    for (const char *cursor = text; *cursor != '\0'; cursor++) {
        if (*cursor < '0' || *cursor > '9') return EINVAL;
    }
    errno = 0;
    unsigned long long parsed = strtoull(text, NULL, 10);
    if (errno != 0) return errno;
    *value = (uint64_t)parsed;
    return 0;
}

static int base64_encoded_length(size_t length, size_t *encoded_length) {
    if (length > (SIZE_MAX - 2U) / 4U * 3U) return EOVERFLOW;
    *encoded_length = ((length + 2U) / 3U) * 4U;
    return 0;
}

static void encode_base64(const unsigned char *input, size_t length, char *output) {
    static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t input_offset = 0;
    size_t output_offset = 0;
    while (input_offset < length) {
        size_t remaining = length - input_offset;
        uint32_t a = input[input_offset++];
        uint32_t b = remaining > 1U ? input[input_offset++] : 0U;
        uint32_t c = remaining > 2U ? input[input_offset++] : 0U;
        uint32_t combined = (a << 16U) | (b << 8U) | c;
        output[output_offset++] = table[(combined >> 18U) & 63U];
        output[output_offset++] = table[(combined >> 12U) & 63U];
        output[output_offset++] = remaining > 1U ? table[(combined >> 6U) & 63U] : '=';
        output[output_offset++] = remaining > 2U ? table[combined & 63U] : '=';
    }
    output[output_offset] = '\0';
}

static char *encode_raw_argv(int argc, char **argv, size_t first_argument, size_t *encoded_length) {
    size_t count = (size_t)argc - first_argument;
    if (count > MAX_RAW_ARGV_COUNT) return NULL;
    size_t raw_length = 0;
    size_t total = 4U + 20U;
    for (size_t index = first_argument; index < (size_t)argc; index++) {
        size_t argument_length = strlen(argv[index]);
        size_t b64_length = 0;
        if (argument_length > MAX_RAW_ARGV_BYTES - raw_length ||
            base64_encoded_length(argument_length, &b64_length) != 0 ||
            b64_length > SIZE_MAX - total - 32U) return NULL;
        raw_length += argument_length;
        total += b64_length + 32U;
    }
    if (total > MAX_RAW_ARGV_CHANNEL_BYTES) return NULL;
    char count_text[32];
    int count_length = snprintf(count_text, sizeof(count_text), "v1;%zu;", count);
    if (count_length < 0) return NULL;
    size_t allocation = (size_t)count_length + total + 1U;
    char *output = malloc(allocation);
    if (output == NULL) return NULL;
    size_t offset = (size_t)count_length;
    memcpy(output, count_text, offset);
    for (size_t index = first_argument; index < (size_t)argc; index++) {
        size_t argument_length = strlen(argv[index]);
        size_t b64_length = 0;
        base64_encoded_length(argument_length, &b64_length);
        int prefix_length = snprintf(output + offset, allocation - offset, "%zu:", argument_length);
        if (prefix_length < 0) {
            free(output);
            return NULL;
        }
        offset += (size_t)prefix_length;
        encode_base64((const unsigned char *)argv[index], argument_length, output + offset);
        offset += b64_length;
        output[offset++] = ';';
    }
    output[offset] = '\0';
    *encoded_length = offset;
    return output;
}

/* Replace any inherited channel with a bounded exact-byte vector before execing Node. */
static int launch_node(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "arena-fs: launch-node requires a Node executable and CLI entry\n");
        return 2;
    }
    size_t raw_argv_length = 0;
    char *raw_argv = encode_raw_argv(argc, argv, 4U, &raw_argv_length);
    if (raw_argv == NULL) {
        fprintf(stderr, "arena-fs: raw argument channel exceeds its 64 KiB limit or allocation failed\n");
        return 2;
    }
    size_t env_count = 0;
    for (char **entry = environ; *entry != NULL; entry++) {
        if (strncmp(*entry, RAW_ARGV_ENV, sizeof(RAW_ARGV_ENV) - 1U) != 0) env_count++;
    }
    char **environment = calloc(env_count + 2U, sizeof(char *));
    if (environment == NULL) {
        free(raw_argv);
        fprintf(stderr, "arena-fs: cannot allocate child environment\n");
        return 2;
    }
    size_t environment_index = 0;
    for (char **entry = environ; *entry != NULL; entry++) {
        if (strncmp(*entry, RAW_ARGV_ENV, sizeof(RAW_ARGV_ENV) - 1U) != 0) {
            environment[environment_index++] = *entry;
        }
    }
    size_t env_value_length = sizeof(RAW_ARGV_ENV) - 1U + raw_argv_length;
    char *env_value = malloc(env_value_length + 1U);
    if (env_value == NULL) {
        free(environment);
        free(raw_argv);
        fprintf(stderr, "arena-fs: cannot allocate raw argument channel\n");
        return 2;
    }
    memcpy(env_value, RAW_ARGV_ENV, sizeof(RAW_ARGV_ENV) - 1U);
    memcpy(env_value + sizeof(RAW_ARGV_ENV) - 1U, raw_argv, raw_argv_length + 1U);
    environment[environment_index] = env_value;
    environment[environment_index + 1U] = NULL;

    size_t child_count = (size_t)argc - 2U;
    char **child_argv = calloc(child_count + 1U, sizeof(char *));
    if (child_argv == NULL) {
        free(env_value);
        free(environment);
        free(raw_argv);
        fprintf(stderr, "arena-fs: cannot allocate Node argument vector\n");
        return 2;
    }
    child_argv[0] = argv[2];
    for (size_t source = 3U, target = 1U; source < (size_t)argc; source++, target++) {
        child_argv[target] = argv[source];
    }
    execve(argv[2], child_argv, environment);
    int error = errno;
    fprintf(stderr, "arena-fs: cannot exec Node (errno %d: %s)\n", error, strerror(error));
    free(child_argv);
    free(env_value);
    free(environment);
    free(raw_argv);
    return error == ENOENT ? 127 : 126;
}

static int decode_root_and_relative(const char *encoded_root, const char *encoded_relative,
                                    char **root, char **relative, size_t *relative_length,
                                    struct fs_error *failure) {
    size_t root_length = 0;
    size_t path_length = 0;
    int error = decode_path_argument(encoded_root, root, &root_length);
    if (error == 0) error = decode_path_argument(encoded_relative, relative, &path_length);
    if (error == 0) error = check_relative_path(*relative, path_length);
    if (error != 0) {
        if (*root != NULL) free(*root);
        if (*relative != NULL) free(*relative);
        *root = NULL;
        *relative = NULL;
        failure->code = error;
        return error;
    }
    if ((*root)[0] != '/') {
        free(*root);
        free(*relative);
        *root = NULL;
        *relative = NULL;
        failure->code = EINVAL;
        return EINVAL;
    }
    *relative_length = path_length;
    return 0;
}

static int run_create(int argc, char **argv) {
    struct fs_error failure = {0};
    char *root = NULL;
    char *relative = NULL;
    size_t relative_length = 0;
    int error = decode_root_and_relative(argv[2], argv[3], &root, &relative, &relative_length, &failure);
    struct stat status;
    if (error == 0) error = create_run_directory(root, relative, relative_length, &failure, &status);
    if (error == 0) print_success("create-run", &status);
    else print_error("create-run", &failure);
    free(root);
    free(relative);
    (void)argc;
    return error == 0 ? 0 : 1;
}

static int run_stage(int argc, char **argv) {
    struct fs_error failure = {0};
    char *root = NULL;
    char *relative = NULL;
    size_t relative_length = 0;
    uint64_t limit = 0;
    int error = parse_u64(argv[4], &limit);
    if (error == 0 && limit > MAX_PLAN_BYTES) error = EFBIG;
    if (error == 0) error = decode_root_and_relative(argv[2], argv[3], &root, &relative,
                                                    &relative_length, &failure);
    if (error == 0) {
        struct stat status;
        error = stage_world_plan(root, relative, relative_length, limit, &failure, &status);
    } else {
        failure.code = error;
    }
    if (error != 0) print_error("stage-world-plan", &failure);
    free(root);
    free(relative);
    (void)argc;
    return error == 0 ? 0 : 1;
}

static int run_read(int argc, char **argv) {
    struct fs_error failure = {0};
    char *root = NULL;
    char *relative = NULL;
    size_t relative_length = 0;
    uint64_t limit = 0;
    unsigned char *contents = NULL;
    size_t contents_length = 0;
    int error = parse_u64(argv[4], &limit);
    if (error == 0 && limit > MAX_READ_BYTES) error = EFBIG;
    if (error == 0) error = decode_root_and_relative(argv[2], argv[3], &root, &relative,
                                                    &relative_length, &failure);
    if (error == 0) error = read_owned_file(root, relative, relative_length, limit, &failure,
                                            &contents, &contents_length);
    else failure.code = error;
    if (error == 0) print_read_success(contents, contents_length);
    else print_error("read-owned-file", &failure);
    free(contents);
    free(root);
    free(relative);
    (void)argc;
    return error == 0 ? 0 : 1;
}

static int run_unlink(int argc, char **argv) {
    struct fs_error failure = {0};
    char *root = NULL;
    char *relative = NULL;
    size_t relative_length = 0;
    uint64_t device = 0;
    uint64_t inode = 0;
    int error = parse_u64(argv[4], &device);
    if (error == 0) error = parse_u64(argv[5], &inode);
    if (error == 0) error = decode_root_and_relative(argv[2], argv[3], &root, &relative,
                                                    &relative_length, &failure);
    bool directory = strcmp(argv[1], "unlink-created-directory") == 0;
    if (error == 0) error = remove_created_entry(root, relative, relative_length,
                                                 (uintmax_t)device, (uintmax_t)inode,
                                                 directory, &failure);
    else failure.code = error;
    if (error == 0) {
        struct stat removed = {0};
        print_success(directory ? "unlink-created-directory" : "unlink-created-file", &removed);
    } else {
        print_error(directory ? "unlink-created-directory" : "unlink-created-file", &failure);
    }
    free(root);
    free(relative);
    (void)argc;
    return error == 0 ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "launch-node") == 0) return launch_node(argc, argv);
    /* Keep private create modes exact regardless of the caller's umask. */
    (void)umask(0077);
    int signal_error = install_signal_handlers();
    if (signal_error != 0) {
        struct fs_error failure = {.code = signal_error};
        print_error("startup", &failure);
        return 1;
    }
    if (argc == 4 && strcmp(argv[1], "create-run") == 0) return run_create(argc, argv);
    if (argc == 5 && strcmp(argv[1], "read-owned-file") == 0) return run_read(argc, argv);
    if (argc == 5 && strcmp(argv[1], "stage-world-plan") == 0) return run_stage(argc, argv);
    if (argc == 6 && (strcmp(argv[1], "unlink-created-file") == 0 ||
                      strcmp(argv[1], "unlink-created-directory") == 0)) return run_unlink(argc, argv);
    fprintf(stderr, "arena-fs: invalid operation or argument count\n");
    return 2;
}
