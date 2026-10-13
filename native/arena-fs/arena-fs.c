#define _DARWIN_C_SOURCE 1
#define _GNU_SOURCE 1

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

#if defined(__APPLE__) && defined(__MACH__) && (defined(__arm64__) || defined(__aarch64__))
#include <stdlib.h>
#define ARENA_SUPPORTED_HOST 1
#elif defined(__linux__) && defined(__x86_64__)
#include <linux/fs.h>
#include <sys/random.h>
#define ARENA_SUPPORTED_HOST 1
#else
#error "arena-fs supports only Darwin arm64 and Linux x86_64"
#endif

#define MAX_OWNED_FILE_BYTES (256U * 1024U * 1024U)
#define MAX_PLAN_BYTES (128U * 1024U * 1024U)
#define MAX_READ_BYTES (16U * 1024U * 1024U)
#define MAX_CLONE_FILES 100000U
#define MAX_CLONE_ENTRIES 200000U
#define MAX_CLONE_PATH_BYTES (64U * 1024U * 1024U)
#define MAX_CLONE_BYTES (UINT64_C(16) * 1024U * 1024U * 1024U)
#define MAX_PATH_BYTES 4096U
#define MAX_PATH_COMPONENTS 128U
#define MAX_RAW_ARGV_COUNT 4096U
#define MAX_RAW_ARGV_BYTES (48U * 1024U)
#define MAX_RAW_ARGV_CHANNEL_BYTES (64U * 1024U)
/* Keep preflight scans finite even when the work tree is malformed or unexpectedly large. */
#define MAX_RESOURCE_SCAN_ENTRIES 1000000U
#define MAX_RESOURCE_SCAN_DEPTH 64U
#define MAX_RESOURCE_SCAN_BYTES (UINT64_C(64) * 1024U * 1024U * 1024U)
#define MAX_OWNED_RUN_LIST_ENTRIES 10000U
#define MAX_OWNED_RUN_CAPACITY 10U
#define MAX_OWNED_TRACE_SEGMENTS 100000U
#define OWNED_RUNS_DIRECTORY ".work/arena/runs"
#define OWNED_FAILURE_ARTIFACT "operational-failure-v1.json"
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

struct owned_run_record {
    char run_id[65];
    dev_t device;
    ino_t inode;
    int64_t modified_time_ns;
    bool has_failure_artifact;
    int64_t failure_artifact_modified_time_ns;
    bool has_terminal_trace;
    unsigned int terminal_trace_sequence;
    int64_t terminal_trace_modified_time_ns;
};

enum owned_tree_entry_type {
    OWNED_TREE_REGULAR,
    OWNED_TREE_DIRECTORY,
    OWNED_TREE_SYMLINK,
};

struct owned_tree_entry {
    char *name;
    dev_t device;
    ino_t inode;
    enum owned_tree_entry_type type;
};

struct owned_tree_usage {
    dev_t device;
    uint64_t entries;
    uint64_t bytes;
};

static int lock_owned_runs_directory(int directory_fd);

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

struct resource_usage {
    uint64_t free_bytes;
    uint64_t work_bytes;
    uint64_t dependency_bytes;
    uint64_t run_count;
    uint64_t entries;
    dev_t device;
};

static int available_bytes(int directory_fd, uint64_t *bytes) {
    struct statvfs status;
    if (fstatvfs(directory_fd, &status) != 0) return errno;
    uintmax_t block_size = (uintmax_t)status.f_frsize;
    uintmax_t available_blocks = (uintmax_t)status.f_bavail;
    if (block_size == 0 || available_blocks > (uintmax_t)UINT64_MAX / block_size) {
        return EOVERFLOW;
    }
    *bytes = (uint64_t)(available_blocks * block_size);
    return 0;
}

static int add_resource_bytes(uint64_t *total, off_t size) {
    if (size < 0) return EOVERFLOW;
    uint64_t amount = (uint64_t)size;
    if (amount > MAX_RESOURCE_SCAN_BYTES - *total) return EFBIG;
    *total += amount;
    return 0;
}

/* Count logical leaf sizes while opening each descendant directory without following links. */
static int scan_resource_directory(int directory_fd, unsigned int depth, bool dependency,
                                   bool inside_runs, struct resource_usage *usage) {
    int scan_fd = fcntl(directory_fd, F_DUPFD_CLOEXEC, 0);
    if (scan_fd < 0) return errno;
    DIR *directory = fdopendir(scan_fd);
    if (directory == NULL) {
        int error = errno;
        close(scan_fd);
        return error;
    }

    int error = 0;
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (usage->entries >= MAX_RESOURCE_SCAN_ENTRIES) {
            error = EFBIG;
            break;
        }
        usage->entries++;

        struct stat status;
        if (fstatat(directory_fd, entry->d_name, &status, AT_SYMLINK_NOFOLLOW) != 0) {
            error = errno;
            break;
        }
        if (status.st_dev != usage->device) {
            error = EXDEV;
            break;
        }
        if (S_ISDIR(status.st_mode)) {
            if (depth >= MAX_RESOURCE_SCAN_DEPTH) {
                error = EFBIG;
                break;
            }
            int child_fd = openat(directory_fd, entry->d_name,
                                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (child_fd < 0) {
                error = errno;
                break;
            }
            struct stat opened_status;
            if (fstat(child_fd, &opened_status) != 0) {
                error = errno;
            } else if (!S_ISDIR(opened_status.st_mode) || opened_status.st_dev != status.st_dev ||
                       opened_status.st_ino != status.st_ino) {
                error = ESTALE;
            } else if (inside_runs && depth == 1U) {
                usage->run_count++;
            }
            bool child_dependency = dependency;
            bool child_inside_runs = inside_runs;
            /* Run data and traces contribute to work totals but not dependency totals. */
            if (depth == 0U) {
                child_dependency = strcmp(entry->d_name, "runs") != 0 &&
                                   strcmp(entry->d_name, "traces") != 0;
                child_inside_runs = strcmp(entry->d_name, "runs") == 0;
            }
            if (error == 0) {
                error = scan_resource_directory(child_fd, depth + 1U, child_dependency,
                                                child_inside_runs, usage);
            }
            if (close(child_fd) != 0 && error == 0) error = errno;
            if (error != 0) break;
        } else if (S_ISREG(status.st_mode) || S_ISLNK(status.st_mode)) {
            error = add_resource_bytes(&usage->work_bytes, status.st_size);
            if (error == 0 && dependency) {
                error = add_resource_bytes(&usage->dependency_bytes, status.st_size);
            }
            if (error != 0) break;
        } else {
            error = ENOTSUP;
            break;
        }
        errno = 0;
    }
    if (error == 0 && errno != 0) error = errno;
    if (closedir(directory) != 0 && error == 0) error = errno;
    return error;
}

static int inspect_owned_resources(const char *root, struct fs_error *failure,
                                   struct resource_usage *usage) {
    int root_fd = open_owned_root(root);
    if (root_fd < 0) {
        failure->code = -root_fd;
        return failure->code;
    }
    int resource_fd = root_fd;
    int work_fd = -1;
    int arena_fd = -1;
    int error = 0;

    int opened_work = open_directory_at(root_fd, ".work");
    if (opened_work < 0) {
        error = -opened_work;
        if (error == ENOENT) error = 0;
    } else {
        work_fd = opened_work;
        error = validate_existing_parent(work_fd);
        resource_fd = work_fd;
    }
    if (error == 0 && work_fd >= 0) {
        int opened_arena = open_directory_at(work_fd, "arena");
        if (opened_arena < 0) {
            error = -opened_arena;
            if (error == ENOENT) error = 0;
        } else {
            arena_fd = opened_arena;
            error = validate_existing_parent(arena_fd);
            resource_fd = arena_fd;
        }
    }
    if (error == 0) error = available_bytes(resource_fd, &usage->free_bytes);
    if (error == 0 && arena_fd >= 0) {
        struct stat arena_status;
        if (fstat(arena_fd, &arena_status) != 0) {
            error = errno;
        } else {
            usage->device = arena_status.st_dev;
            error = scan_resource_directory(arena_fd, 0, true, false, usage);
        }
    }
    if (arena_fd >= 0 && close(arena_fd) != 0 && error == 0) error = errno;
    if (work_fd >= 0 && close(work_fd) != 0 && error == 0) error = errno;
    if (close(root_fd) != 0 && error == 0) error = errno;
    if (error != 0) failure->code = error;
    return error;
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

static int open_relative_directory(int root_fd, const char *path, size_t length,
                                   int *directory_fd) {
    int parent_fd = -1;
    char *leaf = NULL;
    int error = open_relative_parent(root_fd, path, length, &parent_fd, &leaf);
    if (error != 0) return error;
    int opened_fd = open_directory_at(parent_fd, leaf);
    if (opened_fd < 0) {
        error = -opened_fd;
        close(parent_fd);
        free(leaf);
        return error;
    }
    struct stat status;
    if (fstat(opened_fd, &status) != 0) {
        error = errno;
    } else if (!S_ISDIR(status.st_mode)) {
        error = ENOTDIR;
    } else {
        error = validate_existing_parent(opened_fd);
    }
    close(parent_fd);
    free(leaf);
    if (error != 0) {
        close(opened_fd);
        return error;
    }
    *directory_fd = opened_fd;
    return 0;
}

static bool valid_owned_run_id(const char *run_id) {
    size_t length = strlen(run_id);
    if (length == 0 || length > 64U) return false;
    unsigned char first = (unsigned char)run_id[0];
    if (!((first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') ||
          (first >= '0' && first <= '9'))) return false;
    for (size_t index = 1; index < length; index++) {
        unsigned char byte = (unsigned char)run_id[index];
        if (!((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
              (byte >= '0' && byte <= '9') || byte == '_' || byte == '-')) return false;
    }
    return true;
}

static int stat_modified_time_ns(const struct stat *status, int64_t *modified_time_ns) {
#if defined(__APPLE__)
    intmax_t seconds = (intmax_t)status->st_mtimespec.tv_sec;
    long nanoseconds = status->st_mtimespec.tv_nsec;
#else
    intmax_t seconds = (intmax_t)status->st_mtim.tv_sec;
    long nanoseconds = status->st_mtim.tv_nsec;
#endif
    if (seconds > INT64_MAX / INT64_C(1000000000) ||
        seconds < INT64_MIN / INT64_C(1000000000) ||
        nanoseconds < 0 || nanoseconds >= 1000000000L) return EOVERFLOW;
    int64_t base = (int64_t)seconds * INT64_C(1000000000);
    if (base > INT64_MAX - (int64_t)nanoseconds) return EOVERFLOW;
    *modified_time_ns = base + (int64_t)nanoseconds;
    return 0;
}

static int optional_regular_file_mtime(int directory_fd, const char *name, dev_t device,
                                       bool *present, int64_t *modified_time_ns) {
    struct stat status;
    if (fstatat(directory_fd, name, &status, AT_SYMLINK_NOFOLLOW) != 0) {
        if (errno == ENOENT) {
            *present = false;
            return 0;
        }
        return errno;
    }
    if (S_ISLNK(status.st_mode)) return ELOOP;
    if (!S_ISREG(status.st_mode)) return ENOTSUP;
    if (status.st_dev != device) return EXDEV;
    int error = stat_modified_time_ns(&status, modified_time_ns);
    if (error == 0) *present = true;
    return error;
}

static bool parse_owned_trace_segment_name(const char *name, unsigned int *sequence) {
    static const char prefix[] = "trace-v2-";
    static const char suffix[] = ".json";
    size_t length = strlen(name);
    if (length != sizeof(prefix) - 1U + 6U + sizeof(suffix) - 1U ||
        memcmp(name, prefix, sizeof(prefix) - 1U) != 0 ||
        memcmp(name + length - (sizeof(suffix) - 1U), suffix, sizeof(suffix) - 1U) != 0) {
        return false;
    }
    unsigned int value = 0;
    const char *digits = name + sizeof(prefix) - 1U;
    for (size_t index = 0; index < 6U; index++) {
        if (digits[index] < '0' || digits[index] > '9') return false;
        value = value * 10U + (unsigned int)(digits[index] - '0');
    }
    if (value == 0) return false;
    *sequence = value;
    return true;
}

static int terminal_trace_mtime(int run_fd, dev_t device, bool *present,
                                unsigned int *sequence_out, int64_t *modified_time_ns) {
    unsigned char *segments = calloc((MAX_OWNED_TRACE_SEGMENTS + 8U) / 8U, 1U);
    if (segments == NULL) return ENOMEM;
    int scan_fd = fcntl(run_fd, F_DUPFD_CLOEXEC, 0);
    if (scan_fd < 0) {
        free(segments);
        return errno;
    }
    DIR *directory = fdopendir(scan_fd);
    if (directory == NULL) {
        int error = errno;
        close(scan_fd);
        free(segments);
        return error;
    }

    int error = 0;
    uint64_t entries = 0;
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (++entries > MAX_RESOURCE_SCAN_ENTRIES) {
            error = EFBIG;
            break;
        }
        unsigned int sequence = 0;
        if (!parse_owned_trace_segment_name(entry->d_name, &sequence)) {
            errno = 0;
            continue;
        }
        if (sequence > MAX_OWNED_TRACE_SEGMENTS) {
            error = EFBIG;
            break;
        }
        struct stat status;
        if (fstatat(run_fd, entry->d_name, &status, AT_SYMLINK_NOFOLLOW) != 0) {
            error = errno;
            break;
        }
        if (S_ISLNK(status.st_mode)) {
            error = ELOOP;
            break;
        }
        if (!S_ISREG(status.st_mode)) {
            error = ENOTSUP;
            break;
        }
        if (status.st_dev != device) {
            error = EXDEV;
            break;
        }
        size_t byte = (size_t)(sequence / 8U);
        unsigned int bit = sequence % 8U;
        segments[byte] = (unsigned char)(segments[byte] | (unsigned char)(1U << bit));
        errno = 0;
    }
    if (error == 0 && errno != 0) error = errno;
    if (closedir(directory) != 0 && error == 0) error = errno;

    unsigned int terminal = 0;
    if (error == 0) {
        while (terminal < MAX_OWNED_TRACE_SEGMENTS) {
            unsigned int next = terminal + 1U;
            size_t byte = (size_t)(next / 8U);
            unsigned int bit = next % 8U;
            if ((segments[byte] & (unsigned char)(1U << bit)) == 0) break;
            terminal = next;
        }
    }
    free(segments);
    if (error != 0) return error;
    if (terminal == 0) {
        *present = false;
        *sequence_out = 0;
        return 0;
    }
    char name[32];
    int length = snprintf(name, sizeof(name), "trace-v2-%06u.json", terminal);
    if (length < 0 || (size_t)length >= sizeof(name)) return EOVERFLOW;
    struct stat status;
    if (fstatat(run_fd, name, &status, AT_SYMLINK_NOFOLLOW) != 0) return errno;
    if (S_ISLNK(status.st_mode)) return ELOOP;
    if (!S_ISREG(status.st_mode)) return ENOTSUP;
    if (status.st_dev != device) return EXDEV;
    error = stat_modified_time_ns(&status, modified_time_ns);
    if (error == 0) {
        *present = true;
        *sequence_out = terminal;
    }
    return error;
}

static int compare_owned_run_records(const void *left_value, const void *right_value) {
    const struct owned_run_record *left = left_value;
    const struct owned_run_record *right = right_value;
    return strcmp(left->run_id, right->run_id);
}

/* Return one sorted snapshot of real immediate run directories under the fixed runs path. */
static int list_owned_runs(const char *root, struct fs_error *failure,
                           struct owned_run_record **records_out, size_t *count_out) {
    *records_out = NULL;
    *count_out = 0;
    int root_fd = open_owned_root(root);
    if (root_fd < 0) {
        failure->code = -root_fd;
        return failure->code;
    }
    int runs_fd = -1;
    int error = open_relative_directory(root_fd, OWNED_RUNS_DIRECTORY,
                                        sizeof(OWNED_RUNS_DIRECTORY) - 1U, &runs_fd);
    close(root_fd);
    if (error == ENOENT) return 0;
    if (error != 0) {
        failure->code = error;
        return error;
    }
    struct stat runs_status;
    if (fstat(runs_fd, &runs_status) != 0) error = errno;
    struct owned_run_record *records = NULL;
    if (error == 0) {
        records = calloc(MAX_OWNED_RUN_LIST_ENTRIES, sizeof(*records));
        if (records == NULL) error = ENOMEM;
    }
    int scan_fd = -1;
    DIR *directory = NULL;
    if (error == 0) {
        scan_fd = fcntl(runs_fd, F_DUPFD_CLOEXEC, 0);
        if (scan_fd < 0) error = errno;
    }
    if (error == 0) {
        directory = fdopendir(scan_fd);
        if (directory == NULL) error = errno;
    }
    if (error != 0 && scan_fd >= 0 && directory == NULL) close(scan_fd);

    size_t count = 0;
    uint64_t scanned_entries = 0;
    if (error == 0) {
        errno = 0;
        struct dirent *entry;
        while ((entry = readdir(directory)) != NULL) {
            if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
            if (++scanned_entries > MAX_RESOURCE_SCAN_ENTRIES) {
                error = EFBIG;
                break;
            }
            struct stat status;
            if (fstatat(runs_fd, entry->d_name, &status, AT_SYMLINK_NOFOLLOW) != 0) {
                error = errno;
                break;
            }
            if (S_ISLNK(status.st_mode)) {
                error = ELOOP;
                break;
            }
            if (S_ISREG(status.st_mode)) {
                errno = 0;
                continue;
            }
            if (!S_ISDIR(status.st_mode)) {
                error = ENOTSUP;
                break;
            }
            if (!valid_owned_run_id(entry->d_name)) {
                error = EINVAL;
                break;
            }
            if (count >= MAX_OWNED_RUN_LIST_ENTRIES) {
                error = EFBIG;
                break;
            }
            if (status.st_dev != runs_status.st_dev) {
                error = EXDEV;
                break;
            }
            int run_fd = openat(runs_fd, entry->d_name,
                                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (run_fd < 0) {
                error = errno;
                break;
            }
            struct stat opened_status;
            if (fstat(run_fd, &opened_status) != 0) {
                error = errno;
            } else if (!S_ISDIR(opened_status.st_mode) ||
                       opened_status.st_dev != status.st_dev || opened_status.st_ino != status.st_ino) {
                error = ESTALE;
            }
            struct owned_run_record record = {0};
            if (error == 0) {
                memcpy(record.run_id, entry->d_name, strlen(entry->d_name) + 1U);
                record.device = opened_status.st_dev;
                record.inode = opened_status.st_ino;
                error = stat_modified_time_ns(&opened_status, &record.modified_time_ns);
            }
            if (error == 0) {
                error = optional_regular_file_mtime(run_fd, OWNED_FAILURE_ARTIFACT,
                                                    opened_status.st_dev,
                                                    &record.has_failure_artifact,
                                                    &record.failure_artifact_modified_time_ns);
            }
            if (error == 0) {
                error = terminal_trace_mtime(run_fd, opened_status.st_dev,
                                             &record.has_terminal_trace,
                                             &record.terminal_trace_sequence,
                                             &record.terminal_trace_modified_time_ns);
            }
            if (close(run_fd) != 0 && error == 0) error = errno;
            if (error != 0) break;
            records[count++] = record;
            errno = 0;
        }
        if (error == 0 && errno != 0) error = errno;
        if (closedir(directory) != 0 && error == 0) error = errno;
    }
    if (close(runs_fd) != 0 && error == 0) error = errno;
    if (error != 0) {
        free(records);
        failure->code = error;
        return error;
    }
    if (count > 1U) qsort(records, count, sizeof(*records), compare_owned_run_records);
    *records_out = records;
    *count_out = count;
    return 0;
}

static const char *error_category(int error) {
    if (error == EINVAL || error == ENAMETOOLONG || error == E2BIG || error == ENOTDIR) return "invalid_path";
    if (error == EEXIST || error == ENOTEMPTY || error == ESTALE || error == EAGAIN) return "conflict";
    if (error == EACCES || error == EPERM || error == EROFS) return "permission";
    if (error == ELOOP) return "symlink_rejected";
    if (error == ENOENT) return "not_found";
    if (error == EFBIG) return "too_large";
    if (error == ECANCELED) return "cancelled";
    if (error == ENOTSUP || error == EOPNOTSUPP || error == EXDEV) return "unsupported_file_type";
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

static void print_resource_success(const struct resource_usage *usage) {
    printf("{\"v\":1,\"ok\":true,\"operation\":\"inspect-owned-resources\","
           "\"free_bytes\":\"%" PRIu64 "\",\"work_bytes\":\"%" PRIu64 "\","
           "\"dependency_bytes\":\"%" PRIu64 "\",\"run_count\":%" PRIu64 "}\n",
           usage->free_bytes, usage->work_bytes, usage->dependency_bytes, usage->run_count);
    fflush(stdout);
}

static void print_owned_runs_success(const struct owned_run_record *records, size_t count) {
    printf("{\"v\":1,\"ok\":true,\"operation\":\"list-owned-runs\",\"runs\":[");
    for (size_t index = 0; index < count; index++) {
        const struct owned_run_record *record = &records[index];
        if (index > 0) putchar(',');
        printf("{\"run_id\":\"%s\",\"device\":\"%ju\",\"inode\":\"%ju\","
               "\"modified_time_ns\":\"%" PRId64 "\",\"failure_artifact_modified_time_ns\":",
               record->run_id, (uintmax_t)record->device, (uintmax_t)record->inode,
               record->modified_time_ns);
        if (record->has_failure_artifact) {
            printf("\"%" PRId64 "\"", record->failure_artifact_modified_time_ns);
        } else {
            printf("null");
        }
        printf(",\"terminal_trace_sequence\":");
        if (record->has_terminal_trace) {
            printf("%u", record->terminal_trace_sequence);
        } else {
            printf("null");
        }
        printf(",\"terminal_trace_modified_time_ns\":");
        if (record->has_terminal_trace) {
            printf("\"%" PRId64 "\"", record->terminal_trace_modified_time_ns);
        } else {
            printf("null");
        }
        putchar('}');
    }
    puts("]}");
    fflush(stdout);
}

static void print_run_lease_success(const struct stat *lease_status,
                                    const struct stat *run_directory_status) {
    printf("{\"v\":1,\"ok\":true,\"operation\":\"hold-run-lease\","
           "\"device\":\"%ju\",\"inode\":\"%ju\","
           "\"run_device\":\"%ju\",\"run_inode\":\"%ju\"}\n",
           (uintmax_t)lease_status->st_dev, (uintmax_t)lease_status->st_ino,
           (uintmax_t)run_directory_status->st_dev, (uintmax_t)run_directory_status->st_ino);
    fflush(stdout);
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

static int create_random_temp_name(char *name, size_t capacity, const char *prefix);
static int rename_noreplace(int source_parent_fd, const char *source,
                            int destination_parent_fd, const char *destination);

static int unlink_if_identity(int parent_fd, const char *name, dev_t device, ino_t inode,
                              bool directory) {
    char quarantine[NAME_MAX + 1U];
    int error = EEXIST;
    for (unsigned int attempt = 0; attempt < 32U; attempt++) {
        error = create_random_temp_name(quarantine, sizeof(quarantine), ".arena-remove-");
        if (error != 0) return error;
        error = rename_noreplace(parent_fd, name, parent_fd, quarantine);
        if (error != EEXIST) break;
    }
    if (error != 0) return error;

    struct stat found;
    error = identity_at(parent_fd, quarantine, device, inode, directory, &found);
    if (error != 0) {
        int restore_error = rename_noreplace(parent_fd, quarantine, parent_fd, name);
        return restore_error == 0 ? error : restore_error;
    }
    if (unlinkat(parent_fd, quarantine, directory ? AT_REMOVEDIR : 0) != 0) {
        error = errno;
        int restore_error = rename_noreplace(parent_fd, quarantine, parent_fd, name);
        return restore_error == 0 ? error : restore_error;
    }
    return sync_directory(parent_fd);
}

static int verify_owned_run_name(int runs_fd, const char *run_id, dev_t device, ino_t inode) {
    struct stat status;
    if (fstatat(runs_fd, run_id, &status, AT_SYMLINK_NOFOLLOW) != 0) return errno;
    if (S_ISLNK(status.st_mode)) return ELOOP;
    if (!S_ISDIR(status.st_mode)) return ENOTDIR;
    if (status.st_dev != device || status.st_ino != inode) return ESTALE;
    return 0;
}

/* A duplicated directory descriptor shares its readdir offset with the original. */
static int open_owned_tree_stream(int directory_fd) {
    return openat(directory_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

/* Inspect the whole selected run before mutation, opening directories without following links. */
static int scan_owned_tree(int directory_fd, unsigned int depth, struct owned_tree_usage *usage) {
    int scan_fd = open_owned_tree_stream(directory_fd);
    if (scan_fd < 0) return errno;
    DIR *directory = fdopendir(scan_fd);
    if (directory == NULL) {
        int error = errno;
        close(scan_fd);
        return error;
    }
    int error = 0;
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (cancelled()) {
            error = ECANCELED;
            break;
        }
        struct stat status;
        if (fstatat(directory_fd, entry->d_name, &status, AT_SYMLINK_NOFOLLOW) != 0) {
            error = errno;
            break;
        }
        if (usage->entries >= MAX_RESOURCE_SCAN_ENTRIES) {
            error = EFBIG;
            break;
        }
        usage->entries++;
        if (status.st_dev != usage->device) {
            error = EXDEV;
            break;
        }
        if (S_ISDIR(status.st_mode)) {
            if (depth >= MAX_RESOURCE_SCAN_DEPTH) {
                error = EFBIG;
                break;
            }
            int child_fd = openat(directory_fd, entry->d_name,
                                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (child_fd < 0) {
                error = errno;
                break;
            }
            struct stat opened_status;
            if (fstat(child_fd, &opened_status) != 0) {
                error = errno;
            } else if (!S_ISDIR(opened_status.st_mode) || opened_status.st_dev != status.st_dev ||
                       opened_status.st_ino != status.st_ino) {
                error = ESTALE;
            } else {
                error = scan_owned_tree(child_fd, depth + 1U, usage);
            }
            if (close(child_fd) != 0 && error == 0) error = errno;
            if (error != 0) break;
        } else if (S_ISREG(status.st_mode) || S_ISLNK(status.st_mode)) {
            if (status.st_size < 0) {
                error = EOVERFLOW;
                break;
            }
            uint64_t bytes = (uint64_t)status.st_size;
            if (bytes > MAX_RESOURCE_SCAN_BYTES - usage->bytes) {
                error = EFBIG;
                break;
            }
            usage->bytes += bytes;
        } else {
            error = ENOTSUP;
            break;
        }
        errno = 0;
    }
    if (error == 0 && errno != 0) error = errno;
    if (closedir(directory) != 0 && error == 0) error = errno;
    return error;
}

static void free_owned_tree_entries(struct owned_tree_entry *entries, size_t count) {
    for (size_t index = 0; index < count; index++) free(entries[index].name);
    free(entries);
}

static int collect_owned_tree_entries(int directory_fd, struct owned_tree_usage *usage,
                                      struct owned_tree_entry **entries_out, size_t *count_out) {
    int scan_fd = open_owned_tree_stream(directory_fd);
    if (scan_fd < 0) return errno;
    DIR *directory = fdopendir(scan_fd);
    if (directory == NULL) {
        int error = errno;
        close(scan_fd);
        return error;
    }
    struct owned_tree_entry *entries = NULL;
    size_t count = 0;
    size_t capacity = 0;
    int error = 0;
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (cancelled()) {
            error = ECANCELED;
            break;
        }
        struct stat status;
        if (fstatat(directory_fd, entry->d_name, &status, AT_SYMLINK_NOFOLLOW) != 0) {
            error = errno;
            break;
        }
        if (usage->entries >= MAX_RESOURCE_SCAN_ENTRIES) {
            error = EFBIG;
            break;
        }
        usage->entries++;
        if (status.st_dev != usage->device) {
            error = EXDEV;
            break;
        }
        enum owned_tree_entry_type type;
        if (S_ISDIR(status.st_mode)) type = OWNED_TREE_DIRECTORY;
        else if (S_ISREG(status.st_mode)) type = OWNED_TREE_REGULAR;
        else if (S_ISLNK(status.st_mode)) type = OWNED_TREE_SYMLINK;
        else {
            error = ENOTSUP;
            break;
        }
        if (type != OWNED_TREE_DIRECTORY) {
            if (status.st_size < 0) {
                error = EOVERFLOW;
                break;
            }
            uint64_t bytes = (uint64_t)status.st_size;
            if (bytes > MAX_RESOURCE_SCAN_BYTES - usage->bytes) {
                error = EFBIG;
                break;
            }
            usage->bytes += bytes;
        }
        if (count == capacity) {
            size_t next_capacity = capacity == 0 ? 32U : capacity * 2U;
            if (next_capacity > MAX_RESOURCE_SCAN_ENTRIES) next_capacity = MAX_RESOURCE_SCAN_ENTRIES;
            if (next_capacity > SIZE_MAX / sizeof(*entries)) {
                error = EOVERFLOW;
                break;
            }
            struct owned_tree_entry *next_entries = realloc(entries, next_capacity * sizeof(*entries));
            if (next_entries == NULL) {
                error = ENOMEM;
                break;
            }
            entries = next_entries;
            capacity = next_capacity;
        }
        size_t name_length = strlen(entry->d_name);
        entries[count].name = malloc(name_length + 1U);
        if (entries[count].name == NULL) {
            error = ENOMEM;
            break;
        }
        memcpy(entries[count].name, entry->d_name, name_length + 1U);
        entries[count].device = status.st_dev;
        entries[count].inode = status.st_ino;
        entries[count].type = type;
        count++;
        errno = 0;
    }
    if (error == 0 && errno != 0) error = errno;
    if (closedir(directory) != 0 && error == 0) error = errno;
    if (error != 0) {
        free_owned_tree_entries(entries, count);
        return error;
    }
    *entries_out = entries;
    *count_out = count;
    return 0;
}

static bool owned_tree_type_matches(mode_t mode, enum owned_tree_entry_type type) {
    if (type == OWNED_TREE_DIRECTORY) return S_ISDIR(mode);
    if (type == OWNED_TREE_REGULAR) return S_ISREG(mode);
    return S_ISLNK(mode);
}

/* Quarantine one no-follow entry and verify its recorded type and identity before unlinking. */
static int unlink_owned_tree_entry(int parent_fd, const char *name, dev_t device, ino_t inode,
                                   enum owned_tree_entry_type type, int runs_fd,
                                   const char *run_id, dev_t run_device, ino_t run_inode,
                                   bool root_entry) {
    int error = verify_owned_run_name(runs_fd, run_id, run_device, run_inode);
    if (error != 0) return error;
    char quarantine[NAME_MAX + 1U];
    error = EEXIST;
    for (unsigned int attempt = 0; attempt < 32U; attempt++) {
        error = create_random_temp_name(quarantine, sizeof(quarantine), ".arena-remove-");
        if (error != 0) return error;
        error = rename_noreplace(parent_fd, name, parent_fd, quarantine);
        if (error != EEXIST) break;
    }
    if (error != 0) return error;
    struct stat found;
    if (fstatat(parent_fd, quarantine, &found, AT_SYMLINK_NOFOLLOW) != 0) {
        error = errno;
    } else if (!owned_tree_type_matches(found.st_mode, type) ||
               found.st_dev != device || found.st_ino != inode) {
        error = ESTALE;
    }
    if (error == 0 && !root_entry) {
        error = verify_owned_run_name(runs_fd, run_id, run_device, run_inode);
    }
    if (error != 0) {
        int restore_error = rename_noreplace(parent_fd, quarantine, parent_fd, name);
        return restore_error == 0 ? error : restore_error;
    }
    if (unlinkat(parent_fd, quarantine, type == OWNED_TREE_DIRECTORY ? AT_REMOVEDIR : 0) != 0) {
        error = errno;
        int restore_error = rename_noreplace(parent_fd, quarantine, parent_fd, name);
        return restore_error == 0 ? error : restore_error;
    }
    return sync_directory(parent_fd);
}

static int remove_owned_tree_directory(int directory_fd, unsigned int depth,
                                       struct owned_tree_usage *usage, int runs_fd,
                                       const char *run_id, dev_t run_device, ino_t run_inode) {
    struct owned_tree_entry *entries = NULL;
    size_t count = 0;
    int error = collect_owned_tree_entries(directory_fd, usage, &entries, &count);
    for (size_t index = 0; error == 0 && index < count; index++) {
        struct owned_tree_entry *entry = &entries[index];
        error = verify_owned_run_name(runs_fd, run_id, run_device, run_inode);
        if (error != 0) break;
        if (cancelled()) {
            error = ECANCELED;
            break;
        }
        if (entry->type == OWNED_TREE_DIRECTORY) {
            if (depth >= MAX_RESOURCE_SCAN_DEPTH) {
                error = EFBIG;
                break;
            }
            int child_fd = openat(directory_fd, entry->name,
                                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (child_fd < 0) {
                error = errno;
                break;
            }
            struct stat opened_status;
            if (fstat(child_fd, &opened_status) != 0) {
                error = errno;
            } else if (!S_ISDIR(opened_status.st_mode) || opened_status.st_dev != entry->device ||
                       opened_status.st_ino != entry->inode) {
                error = ESTALE;
            } else {
                error = remove_owned_tree_directory(child_fd, depth + 1U, usage, runs_fd,
                                                    run_id, run_device, run_inode);
            }
            if (close(child_fd) != 0 && error == 0) error = errno;
            if (error != 0) break;
        }
        error = unlink_owned_tree_entry(directory_fd, entry->name, entry->device, entry->inode,
                                        entry->type, runs_fd, run_id, run_device, run_inode, false);
    }
    free_owned_tree_entries(entries, count);
    if (error == 0) error = sync_directory(directory_fd);
    return error;
}

static int remove_owned_run_tree(const char *root, const char *run_id,
                                 uintmax_t expected_device, uintmax_t expected_inode,
                                 struct fs_error *failure) {
    if (!valid_owned_run_id(run_id)) {
        failure->code = EINVAL;
        return failure->code;
    }
    int root_fd = open_owned_root(root);
    if (root_fd < 0) {
        failure->code = -root_fd;
        return failure->code;
    }
    int runs_fd = -1;
    int error = open_relative_directory(root_fd, OWNED_RUNS_DIRECTORY,
                                        sizeof(OWNED_RUNS_DIRECTORY) - 1U, &runs_fd);
    close(root_fd);
    if (error != 0) {
        failure->code = error;
        return error;
    }
    error = lock_owned_runs_directory(runs_fd);
    struct stat runs_status;
    if (error == 0 && fstat(runs_fd, &runs_status) != 0) error = errno;
    struct stat named_status;
    if (error == 0 && fstatat(runs_fd, run_id, &named_status, AT_SYMLINK_NOFOLLOW) != 0) {
        error = errno;
    }
    if (error == 0 && S_ISLNK(named_status.st_mode)) error = ELOOP;
    if (error == 0 && !S_ISDIR(named_status.st_mode)) error = ENOTDIR;
    if (error == 0 && (named_status.st_dev != (dev_t)expected_device ||
                       named_status.st_ino != (ino_t)expected_inode)) error = ESTALE;
    if (error == 0 && named_status.st_dev != runs_status.st_dev) error = EXDEV;
    int run_fd = -1;
    if (error == 0) {
        run_fd = openat(runs_fd, run_id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (run_fd < 0) error = errno;
    }
    struct stat opened_status;
    if (error == 0 && fstat(run_fd, &opened_status) != 0) error = errno;
    if (error == 0 && (!S_ISDIR(opened_status.st_mode) ||
                       opened_status.st_dev != (dev_t)expected_device ||
                       opened_status.st_ino != (ino_t)expected_inode)) error = ESTALE;
    struct owned_tree_usage preflight = {.device = (dev_t)expected_device};
    if (error == 0) error = scan_owned_tree(run_fd, 0U, &preflight);
    if (error == 0) error = verify_owned_run_name(runs_fd, run_id,
                                                   (dev_t)expected_device, (ino_t)expected_inode);
    struct owned_tree_usage deletion = {.device = (dev_t)expected_device};
    if (error == 0) {
        error = remove_owned_tree_directory(run_fd, 0U, &deletion, runs_fd, run_id,
                                            (dev_t)expected_device, (ino_t)expected_inode);
    }
    if (run_fd >= 0 && close(run_fd) != 0 && error == 0) error = errno;
    if (error == 0) {
        error = unlink_owned_tree_entry(runs_fd, run_id, (dev_t)expected_device,
                                        (ino_t)expected_inode, OWNED_TREE_DIRECTORY,
                                        runs_fd, run_id, (dev_t)expected_device,
                                        (ino_t)expected_inode, true);
    }
    if (close(runs_fd) != 0 && error == 0) error = errno;
    if (error != 0) failure->code = error;
    return error;
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

static bool is_owned_runs_child_component(const char *relative, size_t relative_length,
                                          size_t component_index) {
    static const char prefix[] = OWNED_RUNS_DIRECTORY "/";
    size_t prefix_length = sizeof(prefix) - 1U;
    return component_index == 3U && relative_length > prefix_length &&
           memcmp(relative, prefix, prefix_length) == 0;
}

static int lock_owned_runs_directory(int directory_fd) {
    for (;;) {
        if (cancelled()) return ECANCELED;
        if (flock(directory_fd, LOCK_EX) == 0) return 0;
        if (errno == EINTR) {
            if (cancelled()) return ECANCELED;
            continue;
        }
        return errno;
    }
}

/* Count only while holding the runs-directory lock shared with create and remove operations. */
static int count_owned_run_directories(int directory_fd, size_t *run_count) {
    struct stat directory_status;
    if (fstat(directory_fd, &directory_status) != 0) return errno;
    int scan_fd = fcntl(directory_fd, F_DUPFD_CLOEXEC, 0);
    if (scan_fd < 0) return errno;
    DIR *directory = fdopendir(scan_fd);
    if (directory == NULL) {
        int error = errno;
        close(scan_fd);
        return error;
    }
    int error = 0;
    size_t count = 0;
    uint64_t entries = 0;
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (++entries > MAX_RESOURCE_SCAN_ENTRIES) {
            error = EFBIG;
            break;
        }
        struct stat status;
        if (fstatat(directory_fd, entry->d_name, &status, AT_SYMLINK_NOFOLLOW) != 0) {
            error = errno;
            break;
        }
        if (S_ISLNK(status.st_mode)) {
            error = ELOOP;
            break;
        }
        if (S_ISREG(status.st_mode)) {
            errno = 0;
            continue;
        }
        if (!S_ISDIR(status.st_mode)) {
            error = ENOTSUP;
            break;
        }
        if (!valid_owned_run_id(entry->d_name)) {
            error = EINVAL;
            break;
        }
        if (status.st_dev != directory_status.st_dev) {
            error = EXDEV;
            break;
        }
        count++;
        if (count > MAX_OWNED_RUN_CAPACITY) {
            error = EFBIG;
            break;
        }
        errno = 0;
    }
    if (error == 0 && errno != 0) error = errno;
    if (closedir(directory) != 0 && error == 0) error = errno;
    if (error == 0) *run_count = count;
    return error;
}

/* Create only the final run leaf; missing ancestors are private and removed on failure. */
static int create_owned_directory(const char *root, const char *relative, size_t relative_length,
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
        if (is_owned_runs_child_component(relative, relative_length, component_index)) {
            if (!valid_owned_run_id(component)) {
                error = EINVAL;
                goto fail;
            }
            error = lock_owned_runs_directory(current_fd);
            if (error != 0) goto fail;
            struct stat existing_status;
            if (fstatat(current_fd, component, &existing_status, AT_SYMLINK_NOFOLLOW) != 0) {
                if (errno != ENOENT) {
                    error = errno;
                    goto fail;
                }
                size_t run_count = 0;
                error = count_owned_run_directories(current_fd, &run_count);
                if (error != 0) goto fail;
                if (run_count >= MAX_OWNED_RUN_CAPACITY) {
                    error = EFBIG;
                    goto fail;
                }
            }
        }
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

static int create_random_temp_name(char *name, size_t capacity, const char *prefix) {
    unsigned char random[16];
    int error = random_bytes(random, sizeof(random));
    if (error != 0) return error;
    static const char hex[] = "0123456789abcdef";
    size_t prefix_length = strlen(prefix);
    size_t needed = prefix_length + sizeof(random) * 2U + 1U;
    if (capacity < needed) return ENAMETOOLONG;
    memcpy(name, prefix, prefix_length);
    size_t offset = prefix_length;
    for (size_t index = 0; index < sizeof(random); index++) {
        name[offset++] = hex[(random[index] >> 4U) & 0xfU];
        name[offset++] = hex[random[index] & 0xfU];
    }
    name[offset] = '\0';
    return 0;
}

/* Rename the synced inode without replacement and verify the destination against its open handle. */
static int stage_owned_file(const char *root, const char *relative, size_t relative_length,
                            uint64_t caller_limit, uint64_t maximum_limit, const char *operation,
                            struct fs_error *failure, struct stat *published_status) {
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

    if (caller_limit > maximum_limit) {
        error = EFBIG;
        goto done;
    }
    uint64_t limit = caller_limit;
    char temporary[NAME_MAX + 1U];
    int temporary_fd = -1;
    for (unsigned int attempt = 0; attempt < 32U; attempt++) {
        if (cancelled()) {
            error = ECANCELED;
            goto done;
        }
        error = create_random_temp_name(temporary, sizeof(temporary), ".arena-stage-");
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
    if (cancelled()) {
        error = ECANCELED;
        goto cleanup_temporary;
    }
    error = rename_noreplace(parent_fd, temporary, parent_fd, destination);
    if (error != 0) goto cleanup_temporary;
    struct stat opened_status;
    if (fstat(temporary_fd, &opened_status) != 0) {
        error = errno;
        goto cleanup_published;
    }
    struct stat destination_status;
    if (fstatat(parent_fd, destination, &destination_status, AT_SYMLINK_NOFOLLOW) != 0) {
        error = errno;
        goto cleanup_published;
    }
    if (!S_ISREG(destination_status.st_mode) ||
        destination_status.st_dev != opened_status.st_dev ||
        destination_status.st_ino != opened_status.st_ino) {
        error = ESTALE;
        int restore_error = rename_noreplace(parent_fd, destination, parent_fd, temporary);
        if (restore_error != 0) failure->cleanup_code = restore_error;
        goto cleanup_temporary;
    }
    failure->published = true;
    failure->device = opened_status.st_dev;
    failure->inode = opened_status.st_ino;
    *published_status = opened_status;
    if (cancelled()) {
        error = ECANCELED;
        goto cleanup_published;
    }
    error = sync_directory(parent_fd);
    if (error != 0) goto cleanup_published;
    if (close(temporary_fd) != 0) {
        temporary_fd = -1;
        error = errno;
        goto cleanup_published;
    }
    temporary_fd = -1;
    failure->published = false;
    print_success(operation, published_status);
    close(parent_fd);
    free(destination);
    return 0;

cleanup_published:
    if (temporary_fd >= 0 && close(temporary_fd) != 0 && failure->cleanup_code == 0) {
        failure->cleanup_code = errno;
    }
    temporary_fd = -1;
    {
        int cleanup_error = unlink_if_identity(parent_fd, destination,
                                               temporary_status.st_dev, temporary_status.st_ino, false);
        if (cleanup_error != 0 && failure->cleanup_code == 0) failure->cleanup_code = cleanup_error;
        failure->published = cleanup_error != 0;
    }
    goto done;

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

struct clone_entry {
    char *path;
    size_t path_length;
    dev_t device;
    ino_t inode;
    bool directory;
};

struct clone_state {
    int staging_root_fd;
    struct clone_entry *entries;
    size_t entry_count;
    size_t entry_capacity;
    size_t path_bytes;
    uint64_t files;
    uint64_t total_bytes;
    uint64_t max_files;
    uint64_t max_bytes;
    dev_t source_device;
};

#if defined(__APPLE__)
static bool same_timespec(struct timespec left, struct timespec right) {
    return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}

static bool same_snapshot_status(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
           left->st_mode == right->st_mode && left->st_size == right->st_size &&
           same_timespec(left->st_mtimespec, right->st_mtimespec) &&
           same_timespec(left->st_ctimespec, right->st_ctimespec);
}
#else
static bool same_timespec(struct timespec left, struct timespec right) {
    return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}

static bool same_snapshot_status(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
           left->st_mode == right->st_mode && left->st_size == right->st_size &&
           same_timespec(left->st_mtim, right->st_mtim) &&
           same_timespec(left->st_ctim, right->st_ctim);
}
#endif

static bool paths_overlap(const char *left, size_t left_length,
                          const char *right, size_t right_length) {
    size_t common = left_length < right_length ? left_length : right_length;
    if (memcmp(left, right, common) != 0) return false;
    if (left_length == right_length) return true;
    if (left_length < right_length) return right[left_length] == '/';
    return left[right_length] == '/';
}

static int rename_noreplace(int source_parent_fd, const char *source,
                            int destination_parent_fd, const char *destination) {
#if defined(__APPLE__)
    if (renameatx_np(source_parent_fd, source, destination_parent_fd, destination, RENAME_EXCL) != 0) {
        return errno;
    }
#elif defined(__linux__)
    if (renameat2(source_parent_fd, source, destination_parent_fd, destination, RENAME_NOREPLACE) != 0) {
        return errno;
    }
#endif
    return 0;
}

static int record_clone_entry(struct clone_state *state, const char *path, size_t path_length,
                              const struct stat *status, bool directory) {
    if (state->entry_count >= MAX_CLONE_ENTRIES || path_length > MAX_PATH_BYTES ||
        path_length > MAX_CLONE_PATH_BYTES - state->path_bytes) return EFBIG;
    if (state->entry_count == state->entry_capacity) {
        size_t next_capacity = state->entry_capacity == 0 ? 64U : state->entry_capacity * 2U;
        if (next_capacity > MAX_CLONE_ENTRIES) next_capacity = MAX_CLONE_ENTRIES;
        if (next_capacity > SIZE_MAX / sizeof(struct clone_entry)) return EOVERFLOW;
        struct clone_entry *next_entries = realloc(state->entries,
                                                     next_capacity * sizeof(struct clone_entry));
        if (next_entries == NULL) return ENOMEM;
        state->entries = next_entries;
        state->entry_capacity = next_capacity;
    }
    char *path_copy = malloc(path_length + 1U);
    if (path_copy == NULL) return ENOMEM;
    memcpy(path_copy, path, path_length);
    path_copy[path_length] = '\0';
    state->entries[state->entry_count++] = (struct clone_entry){
        .path = path_copy,
        .path_length = path_length,
        .device = status->st_dev,
        .inode = status->st_ino,
        .directory = directory,
    };
    state->path_bytes += path_length;
    return 0;
}

static int append_clone_path(const char *parent, size_t parent_length, const char *name,
                             size_t name_length, char **path, size_t *path_length) {
    size_t separator_length = parent_length == 0 ? 0U : 1U;
    if (parent_length > MAX_PATH_BYTES || separator_length > MAX_PATH_BYTES - parent_length ||
        name_length > MAX_PATH_BYTES - parent_length - separator_length) return ENAMETOOLONG;
    size_t length = parent_length + separator_length + name_length;
    char *result = malloc(length + 1U);
    if (result == NULL) return ENOMEM;
    if (parent_length > 0) memcpy(result, parent, parent_length);
    if (separator_length > 0) result[parent_length] = '/';
    memcpy(result + parent_length + separator_length, name, name_length);
    result[length] = '\0';
    *path = result;
    *path_length = length;
    return 0;
}

static int unlink_clone_entry(struct clone_state *state, const struct clone_entry *entry) {
    int parent_fd = -1;
    char *leaf = NULL;
    int error = open_relative_parent(state->staging_root_fd, entry->path, entry->path_length,
                                     &parent_fd, &leaf);
    if (error == ENOENT) return 0;
    if (error != 0) return error;
    error = unlink_if_identity(parent_fd, leaf, entry->device, entry->inode, entry->directory);
    if (error == ENOENT) error = 0;
    close(parent_fd);
    free(leaf);
    return error;
}

static int cleanup_clone_entries(struct clone_state *state) {
    int first_error = 0;
    for (size_t index = state->entry_count; index > 0; index--) {
        int error = unlink_clone_entry(state, &state->entries[index - 1U]);
        if (error != 0 && first_error == 0) first_error = error;
    }
    return first_error;
}

static void free_clone_state(struct clone_state *state) {
    for (size_t index = 0; index < state->entry_count; index++) free(state->entries[index].path);
    free(state->entries);
    state->entries = NULL;
    state->entry_count = 0;
    state->entry_capacity = 0;
    state->path_bytes = 0;
}

/* EOF on the control pipe starts the copy; a signal can abort before tree traversal. */
static int wait_for_clone_start(void) {
    for (;;) {
        if (cancelled()) return ECANCELED;
        unsigned char byte;
        ssize_t amount = read(STDIN_FILENO, &byte, sizeof(byte));
        if (amount == 0) return 0;
        if (amount > 0) return EINVAL;
        if (errno == EINTR) {
            if (cancelled()) return ECANCELED;
            continue;
        }
        return errno;
    }
}

static int copy_regular_file(int source_directory_fd, int destination_directory_fd,
                             const char *name, const struct stat *expected_source_status,
                             const char *relative_path, size_t path_length,
                             struct clone_state *state) {
    if (state->files >= state->max_files) return EFBIG;
    int source_fd = openat(source_directory_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (source_fd < 0) {
        int error = errno;
        if (error == ENOTDIR || error == ELOOP) {
            struct stat link_status;
            if (fstatat(source_directory_fd, name, &link_status, AT_SYMLINK_NOFOLLOW) == 0 &&
                S_ISLNK(link_status.st_mode)) error = ELOOP;
        }
        return error;
    }
    struct stat source_status;
    if (fstat(source_fd, &source_status) != 0) {
        int error = errno;
        close(source_fd);
        return error;
    }
    if (!S_ISREG(source_status.st_mode)) {
        close(source_fd);
        return EOPNOTSUPP;
    }
    if (!same_snapshot_status(expected_source_status, &source_status)) {
        close(source_fd);
        return ESTALE;
    }
    if (source_status.st_dev != state->source_device) {
        close(source_fd);
        return EXDEV;
    }
    if (source_status.st_size < 0 || (uint64_t)source_status.st_size > state->max_bytes - state->total_bytes) {
        close(source_fd);
        return EFBIG;
    }

    int destination_fd = openat(destination_directory_fd, name,
                                O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (destination_fd < 0) {
        int error = errno;
        close(source_fd);
        return error;
    }
    struct stat destination_status;
    if (fstat(destination_fd, &destination_status) != 0) {
        int error = errno;
        close(source_fd);
        close(destination_fd);
        return error;
    }
    if (!S_ISREG(destination_status.st_mode)) {
        close(source_fd);
        close(destination_fd);
        return EINVAL;
    }
    int error = record_clone_entry(state, relative_path, path_length, &destination_status, false);
    if (error != 0) {
        int cleanup_error = unlink_if_identity(destination_directory_fd, name,
                                              destination_status.st_dev, destination_status.st_ino, false);
        close(source_fd);
        close(destination_fd);
        return cleanup_error == 0 ? error : cleanup_error;
    }
    state->files++;

    uint64_t copied = 0;
    unsigned char buffer[65536];
    while (error == 0) {
        if (cancelled()) {
            error = ECANCELED;
            break;
        }
        ssize_t amount = read(source_fd, buffer, sizeof(buffer));
        if (amount < 0) {
            if (errno == EINTR && cancelled()) error = ECANCELED;
            else if (errno != EINTR) error = errno;
            continue;
        }
        if (amount == 0) break;
        uint64_t amount_u64 = (uint64_t)amount;
        if (amount_u64 > state->max_bytes - state->total_bytes) {
            error = EFBIG;
            break;
        }
        error = write_all(destination_fd, buffer, (size_t)amount);
        if (error != 0) break;
        copied += amount_u64;
        state->total_bytes += amount_u64;
    }

    struct stat after_status;
    if (error == 0 && fstat(source_fd, &after_status) != 0) error = errno;
    if (error == 0 && (!same_snapshot_status(&source_status, &after_status) ||
                       copied != (uint64_t)source_status.st_size)) error = ESTALE;
    if (error == 0 && fsync(destination_fd) != 0) error = errno;
    if (close(source_fd) != 0 && error == 0) error = errno;
    if (close(destination_fd) != 0 && error == 0) error = errno;
    return error;
}

static int copy_tree_directory(int source_fd, int destination_fd, const char *relative_path,
                               size_t path_length, size_t depth, struct clone_state *state) {
    if (depth >= MAX_PATH_COMPONENTS) return E2BIG;
    struct stat source_before;
    if (fstat(source_fd, &source_before) != 0) return errno;
    if (!S_ISDIR(source_before.st_mode) || source_before.st_dev != state->source_device) return EXDEV;

    int scan_fd = dup(source_fd);
    if (scan_fd < 0) return errno;
    DIR *directory = fdopendir(scan_fd);
    if (directory == NULL) {
        int error = errno;
        close(scan_fd);
        return error;
    }
    int error = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (entry == NULL) {
            if (errno != 0) error = errno;
            break;
        }
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (cancelled()) {
            error = ECANCELED;
            break;
        }
        struct stat child_status;
        if (fstatat(source_fd, entry->d_name, &child_status, AT_SYMLINK_NOFOLLOW) != 0) {
            error = errno;
            break;
        }
        if (S_ISLNK(child_status.st_mode)) {
            error = ELOOP;
            break;
        }
        if (child_status.st_dev != state->source_device) {
            error = EXDEV;
            break;
        }
        char *child_path = NULL;
        size_t child_path_length = 0;
        error = append_clone_path(relative_path, path_length, entry->d_name, strlen(entry->d_name),
                                  &child_path, &child_path_length);
        if (error != 0) break;

        if (S_ISDIR(child_status.st_mode)) {
            if (mkdirat(destination_fd, entry->d_name, 0700) != 0) {
                error = errno;
                free(child_path);
                break;
            }
            struct stat created_status;
            if (fstatat(destination_fd, entry->d_name, &created_status, AT_SYMLINK_NOFOLLOW) != 0) {
                error = errno;
                free(child_path);
                break;
            }
            if (!S_ISDIR(created_status.st_mode)) {
                error = ESTALE;
                free(child_path);
                break;
            }
            error = record_clone_entry(state, child_path, child_path_length, &created_status, true);
            if (error != 0) {
                int cleanup_error = unlink_if_identity(destination_fd, entry->d_name,
                                                       created_status.st_dev, created_status.st_ino, true);
                if (cleanup_error != 0) error = cleanup_error;
                free(child_path);
                break;
            }
            int child_source_fd = open_directory_at(source_fd, entry->d_name);
            if (child_source_fd < 0) {
                error = -child_source_fd;
                free(child_path);
                break;
            }
            struct stat opened_source_status;
            if (fstat(child_source_fd, &opened_source_status) != 0) {
                error = errno;
                close(child_source_fd);
                free(child_path);
                break;
            }
            if (!same_snapshot_status(&child_status, &opened_source_status)) {
                error = ESTALE;
                close(child_source_fd);
                free(child_path);
                break;
            }
            int child_destination_fd = open_directory_at(destination_fd, entry->d_name);
            if (child_destination_fd < 0) {
                error = -child_destination_fd;
                close(child_source_fd);
                free(child_path);
                break;
            }
            struct stat opened_destination_status;
            if (fstat(child_destination_fd, &opened_destination_status) != 0) {
                error = errno;
                close(child_source_fd);
                close(child_destination_fd);
                free(child_path);
                break;
            }
            if (opened_destination_status.st_dev != created_status.st_dev ||
                opened_destination_status.st_ino != created_status.st_ino ||
                !S_ISDIR(opened_destination_status.st_mode)) {
                error = ESTALE;
                close(child_source_fd);
                close(child_destination_fd);
                free(child_path);
                break;
            }
            error = copy_tree_directory(child_source_fd, child_destination_fd,
                                        child_path, child_path_length, depth + 1U, state);
            close(child_source_fd);
            close(child_destination_fd);
        } else if (S_ISREG(child_status.st_mode)) {
            error = copy_regular_file(source_fd, destination_fd, entry->d_name, &child_status,
                                      child_path, child_path_length, state);
        } else {
            error = EOPNOTSUPP;
        }
        free(child_path);
        if (error != 0) break;
    }
    if (closedir(directory) != 0 && error == 0) error = errno;
    struct stat source_after;
    if (error == 0 && fstat(source_fd, &source_after) != 0) error = errno;
    if (error == 0 && !same_snapshot_status(&source_before, &source_after)) error = ESTALE;
    if (error == 0) error = sync_directory(destination_fd);
    return error;
}

/* Publish a complete private copy by an OS-specific no-replace directory rename. */
static int clone_owned_tree(const char *root, const char *source, size_t source_length,
                            const char *destination, size_t destination_length,
                            uint64_t max_files, uint64_t max_bytes,
                            struct fs_error *failure, struct stat *published_status) {
    if (paths_overlap(source, source_length, destination, destination_length)) {
        failure->code = EINVAL;
        return EINVAL;
    }
    int root_fd = open_owned_root(root);
    if (root_fd < 0) {
        failure->code = -root_fd;
        return failure->code;
    }
    int source_fd = -1;
    int error = open_relative_directory(root_fd, source, source_length, &source_fd);
    if (error != 0) {
        close(root_fd);
        failure->code = error;
        return error;
    }
    struct stat source_status;
    if (fstat(source_fd, &source_status) != 0) {
        error = errno;
        close(source_fd);
        close(root_fd);
        failure->code = error;
        return error;
    }

    int parent_fd = -1;
    char *destination_leaf = NULL;
    error = open_relative_parent(root_fd, destination, destination_length,
                                 &parent_fd, &destination_leaf);
    if (error != 0) {
        close(source_fd);
        close(root_fd);
        failure->code = error;
        return error;
    }
    struct stat existing;
    if (fstatat(parent_fd, destination_leaf, &existing, AT_SYMLINK_NOFOLLOW) == 0) {
        error = EEXIST;
        goto clone_done;
    }
    if (errno != ENOENT) {
        error = errno;
        goto clone_done;
    }

    char temporary[NAME_MAX + 1U];
    error = create_random_temp_name(temporary, sizeof(temporary), ".arena-clone-");
    if (error != 0) goto clone_done;
    if (mkdirat(parent_fd, temporary, 0700) != 0) {
        error = errno;
        goto clone_done;
    }
    struct stat staging_status;
    if (fstatat(parent_fd, temporary, &staging_status, AT_SYMLINK_NOFOLLOW) != 0) {
        error = errno;
        failure->cleanup_code = error;
        goto clone_done;
    }
    if (!S_ISDIR(staging_status.st_mode)) {
        error = ESTALE;
        failure->cleanup_code = error;
        goto clone_done;
    }
    size_t parent_length = 0;
    for (size_t index = 0; index < destination_length; index++) {
        if (destination[index] == '/') parent_length = index + 1U;
    }
    size_t temporary_path_length = parent_length + strlen(temporary);
    if (temporary_path_length > MAX_PATH_BYTES) {
        error = ENAMETOOLONG;
        goto cleanup_root;
    }
    char temporary_path[MAX_PATH_BYTES + 1U];
    memcpy(temporary_path, destination, parent_length);
    memcpy(temporary_path + parent_length, temporary, strlen(temporary));
    temporary_path[temporary_path_length] = '\0';
    error = print_created_event("created-directory", temporary_path,
                                temporary_path_length, &staging_status);
    if (error != 0) goto cleanup_root;
    int staging_fd = open_directory_at(parent_fd, temporary);
    if (staging_fd < 0) {
        error = -staging_fd;
        goto cleanup_root;
    }
    struct stat opened_staging_status;
    if (fstat(staging_fd, &opened_staging_status) != 0) {
        error = errno;
        close(staging_fd);
        goto cleanup_root;
    }
    if (opened_staging_status.st_dev != staging_status.st_dev ||
        opened_staging_status.st_ino != staging_status.st_ino ||
        !S_ISDIR(opened_staging_status.st_mode)) {
        error = ESTALE;
        close(staging_fd);
        goto cleanup_root;
    }
    if (sync_directory(parent_fd) != 0) {
        error = errno;
        close(staging_fd);
        goto cleanup_root;
    }

    struct clone_state state = {
        .staging_root_fd = staging_fd,
        .max_files = max_files,
        .max_bytes = max_bytes,
        .source_device = source_status.st_dev,
    };
    error = wait_for_clone_start();
    if (error == 0) error = copy_tree_directory(source_fd, staging_fd, "", 0, 0, &state);
    if (error == 0 && cancelled()) error = ECANCELED;
    if (error == 0) error = sync_directory(staging_fd);
    bool published = false;
    if (error == 0) {
        error = rename_noreplace(parent_fd, temporary, parent_fd, destination_leaf);
        if (error == 0) {
            struct stat opened_publication_status;
            struct stat destination_status;
            if (fstat(staging_fd, &opened_publication_status) != 0) {
                error = errno;
            } else if (fstatat(parent_fd, destination_leaf, &destination_status, AT_SYMLINK_NOFOLLOW) != 0) {
                error = errno;
            } else if (!S_ISDIR(destination_status.st_mode) ||
                       destination_status.st_dev != opened_publication_status.st_dev ||
                       destination_status.st_ino != opened_publication_status.st_ino) {
                error = ESTALE;
                int restore_error = rename_noreplace(parent_fd, destination_leaf,
                                                     parent_fd, temporary);
                if (restore_error != 0) failure->cleanup_code = restore_error;
            } else {
                published = true;
                *published_status = opened_publication_status;
                failure->published = true;
                failure->device = opened_publication_status.st_dev;
                failure->inode = opened_publication_status.st_ino;
                error = print_created_event("clone-published", destination, destination_length,
                                            &opened_publication_status);
                if (error == 0 && cancelled()) error = ECANCELED;
                if (error == 0) error = sync_directory(parent_fd);
            }
        }
    }
    if (error != 0) {
        int cleanup_error = cleanup_clone_entries(&state);
        if (cleanup_error != 0 && failure->cleanup_code == 0) failure->cleanup_code = cleanup_error;
        const char *root_name = published ? destination_leaf : temporary;
        int root_cleanup_error = unlink_if_identity(parent_fd, root_name,
                                                    staging_status.st_dev, staging_status.st_ino, true);
        if (root_cleanup_error != 0 && root_cleanup_error != ENOENT && failure->cleanup_code == 0) {
            failure->cleanup_code = root_cleanup_error;
        }
        struct stat remaining;
        if (fstatat(parent_fd, root_name, &remaining, AT_SYMLINK_NOFOLLOW) == 0 &&
            remaining.st_dev == staging_status.st_dev && remaining.st_ino == staging_status.st_ino &&
            S_ISDIR(remaining.st_mode)) {
            failure->published = published;
        } else {
            failure->published = false;
        }
    } else {
        failure->published = false;
    }
    free_clone_state(&state);
    close(staging_fd);
    if (error == 0) {
        print_success("clone-owned-tree", published_status);
        close(parent_fd);
        free(destination_leaf);
        close(source_fd);
        close(root_fd);
        return 0;
    }
    goto clone_done;

cleanup_root:
    {
        int root_cleanup_error = unlink_if_identity(parent_fd, temporary,
                                                    staging_status.st_dev, staging_status.st_ino, true);
        if (root_cleanup_error != 0 && root_cleanup_error != ENOENT && failure->cleanup_code == 0) {
            failure->cleanup_code = root_cleanup_error;
        }
    }
clone_done:
    failure->code = error;
    close(parent_fd);
    free(destination_leaf);
    close(source_fd);
    close(root_fd);
    return error;
}

/* Keep the per-run advisory lock alive in this helper until its owner closes stdin. */
static int hold_run_lease(const char *root, const char *relative, size_t relative_length,
                          struct fs_error *failure, struct stat *lease_status,
                          struct stat *run_directory_status) {
    int root_fd = open_owned_root(root);
    if (root_fd < 0) {
        failure->code = -root_fd;
        return failure->code;
    }
    int run_fd = -1;
    int error = open_relative_directory(root_fd, relative, relative_length, &run_fd);
    close(root_fd);
    if (error != 0) {
        failure->code = error;
        return error;
    }
    int lock_fd = openat(run_fd, ".arena-run.lock",
                         O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0600);
    if (lock_fd < 0) {
        error = errno;
        close(run_fd);
        failure->code = error;
        return error;
    }
    if (fstat(lock_fd, lease_status) != 0) {
        error = errno;
        close(lock_fd);
        close(run_fd);
        failure->code = error;
        return error;
    }
    if (!S_ISREG(lease_status->st_mode) || lease_status->st_nlink != 1 ||
        lease_status->st_uid != geteuid() || (lease_status->st_mode & 0777) != 0600) {
        close(lock_fd);
        close(run_fd);
        failure->code = EACCES;
        return EACCES;
    }
    if (flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
        error = errno;
        close(lock_fd);
        close(run_fd);
        failure->code = error;
        return error;
    }
    if (fstat(run_fd, run_directory_status) != 0) {
        error = errno;
        close(lock_fd);
        close(run_fd);
        failure->code = error;
        return error;
    }
    if (!S_ISDIR(run_directory_status->st_mode)) {
        close(lock_fd);
        close(run_fd);
        failure->code = ENOTDIR;
        return ENOTDIR;
    }
    print_run_lease_success(lease_status, run_directory_status);
    for (;;) {
        if (cancelled()) break;
        unsigned char byte;
        ssize_t amount = read(STDIN_FILENO, &byte, sizeof(byte));
        if (amount == 0) break;
        if (amount > 0) {
            error = EINVAL;
            break;
        }
        if (errno == EINTR) {
            if (cancelled()) break;
            continue;
        }
        error = errno;
        break;
    }
    close(lock_fd);
    close(run_fd);
    if (error != 0) {
        failure->code = error;
        return error;
    }
    return 0;
}

/* Quarantine the leaf before checking identity so a public-name replacement survives. */
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
    error = cancelled()
        ? ECANCELED
        : unlink_if_identity(parent_fd, leaf, (dev_t)expected_device, (ino_t)expected_inode, directory);
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

static int run_create(int argc, char **argv, const char *operation) {
    struct fs_error failure = {0};
    char *root = NULL;
    char *relative = NULL;
    size_t relative_length = 0;
    int error = decode_root_and_relative(argv[2], argv[3], &root, &relative, &relative_length, &failure);
    struct stat status;
    if (error == 0) error = create_owned_directory(root, relative, relative_length, &failure, &status);
    if (error == 0) print_success(operation, &status);
    else print_error(operation, &failure);
    free(root);
    free(relative);
    (void)argc;
    return error == 0 ? 0 : 1;
}

static int run_stage(int argc, char **argv, const char *operation) {
    struct fs_error failure = {0};
    char *root = NULL;
    char *relative = NULL;
    size_t relative_length = 0;
    uint64_t limit = 0;
    int error = parse_u64(argv[4], &limit);
    uint64_t maximum_limit = strcmp(operation, "stage-world-plan") == 0
        ? MAX_PLAN_BYTES
        : MAX_OWNED_FILE_BYTES;
    if (error == 0 && limit > maximum_limit) error = EFBIG;
    if (error == 0) error = decode_root_and_relative(argv[2], argv[3], &root, &relative,
                                                    &relative_length, &failure);
    if (error == 0) {
        struct stat status;
        error = stage_owned_file(root, relative, relative_length, limit, maximum_limit,
                                 operation, &failure, &status);
    } else {
        failure.code = error;
    }
    if (error != 0) print_error(operation, &failure);
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

static int run_inspect_resources(int argc, char **argv) {
    struct fs_error failure = {0};
    struct resource_usage usage = {0};
    char *root = NULL;
    size_t root_length = 0;
    int error = decode_path_argument(argv[2], &root, &root_length);
    if (error == 0 && (root_length == 0 || root[0] != '/')) error = EINVAL;
    if (error == 0) error = inspect_owned_resources(root, &failure, &usage);
    else failure.code = error;
    if (error == 0) print_resource_success(&usage);
    else print_error("inspect-owned-resources", &failure);
    free(root);
    (void)argc;
    return error == 0 ? 0 : 1;
}

static int run_list_owned_runs(int argc, char **argv) {
    struct fs_error failure = {0};
    char *root = NULL;
    size_t root_length = 0;
    struct owned_run_record *records = NULL;
    size_t count = 0;
    int error = decode_path_argument(argv[2], &root, &root_length);
    if (error == 0 && (root_length == 0 || root[0] != '/')) error = EINVAL;
    if (error == 0) error = list_owned_runs(root, &failure, &records, &count);
    else failure.code = error;
    if (error == 0) print_owned_runs_success(records, count);
    else print_error("list-owned-runs", &failure);
    free(records);
    free(root);
    (void)argc;
    return error == 0 ? 0 : 1;
}

static int run_remove_owned_tree(int argc, char **argv) {
    struct fs_error failure = {0};
    char *root = NULL;
    size_t root_length = 0;
    uint64_t device = 0;
    uint64_t inode = 0;
    int error = parse_u64(argv[4], &device);
    if (error == 0) error = parse_u64(argv[5], &inode);
    if (error == 0) error = decode_path_argument(argv[2], &root, &root_length);
    if (error == 0 && (root_length == 0 || root[0] != '/')) error = EINVAL;
    if (error == 0) error = remove_owned_run_tree(root, argv[3], (uintmax_t)device,
                                                  (uintmax_t)inode, &failure);
    else failure.code = error;
    if (error == 0) {
        printf("{\"v\":1,\"ok\":true,\"operation\":\"remove-owned-run-tree\"}\n");
        fflush(stdout);
    } else {
        print_error("remove-owned-run-tree", &failure);
    }
    free(root);
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

static int run_clone_tree(int argc, char **argv) {
    struct fs_error failure = {0};
    char *root = NULL;
    char *source = NULL;
    char *destination = NULL;
    size_t root_length = 0;
    size_t source_length = 0;
    size_t destination_length = 0;
    uint64_t max_files = 0;
    uint64_t max_bytes = 0;
    int error = parse_u64(argv[5], &max_files);
    if (error == 0) error = parse_u64(argv[6], &max_bytes);
    if (error == 0 && max_files > MAX_CLONE_FILES) error = EFBIG;
    if (error == 0 && max_bytes > MAX_CLONE_BYTES) error = EFBIG;
    if (error == 0) error = decode_path_argument(argv[2], &root, &root_length);
    if (error == 0) error = decode_path_argument(argv[3], &source, &source_length);
    if (error == 0) error = decode_path_argument(argv[4], &destination, &destination_length);
    if (error == 0 && root[0] != '/') error = EINVAL;
    if (error == 0) error = check_relative_path(source, source_length);
    if (error == 0) error = check_relative_path(destination, destination_length);
    if (error == 0) {
        struct stat status;
        error = clone_owned_tree(root, source, source_length, destination, destination_length,
                                 max_files, max_bytes, &failure, &status);
    } else {
        failure.code = error;
    }
    if (error != 0) print_error("clone-owned-tree", &failure);
    free(root);
    free(source);
    free(destination);
    (void)argc;
    return error == 0 ? 0 : 1;
}

static int run_hold_lease(int argc, char **argv) {
    struct fs_error failure = {0};
    char *root = NULL;
    char *relative = NULL;
    size_t relative_length = 0;
    int error = decode_root_and_relative(argv[2], argv[3], &root, &relative,
                                         &relative_length, &failure);
    if (error == 0) {
        struct stat lease_status;
        struct stat run_directory_status;
        error = hold_run_lease(root, relative, relative_length, &failure,
                               &lease_status, &run_directory_status);
    }
    if (error != 0) print_error("hold-run-lease", &failure);
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
    if (argc == 4 && strcmp(argv[1], "create-run") == 0) return run_create(argc, argv, "create-run");
    if (argc == 4 && strcmp(argv[1], "create-owned-directory") == 0) {
        return run_create(argc, argv, "create-owned-directory");
    }
    if (argc == 4 && strcmp(argv[1], "hold-run-lease") == 0) return run_hold_lease(argc, argv);
    if (argc == 5 && strcmp(argv[1], "read-owned-file") == 0) return run_read(argc, argv);
    if (argc == 3 && strcmp(argv[1], "inspect-owned-resources") == 0) {
        return run_inspect_resources(argc, argv);
    }
    if (argc == 3 && strcmp(argv[1], "list-owned-runs") == 0) {
        return run_list_owned_runs(argc, argv);
    }
    if (argc == 6 && strcmp(argv[1], "remove-owned-run-tree") == 0) {
        return run_remove_owned_tree(argc, argv);
    }
    if (argc == 5 && strcmp(argv[1], "stage-world-plan") == 0) {
        return run_stage(argc, argv, "stage-world-plan");
    }
    if (argc == 5 && strcmp(argv[1], "stage-owned-file") == 0) {
        return run_stage(argc, argv, "stage-owned-file");
    }
    if (argc == 7 && strcmp(argv[1], "clone-owned-tree") == 0) return run_clone_tree(argc, argv);
    if (argc == 6 && (strcmp(argv[1], "unlink-created-file") == 0 ||
                      strcmp(argv[1], "unlink-created-directory") == 0)) return run_unlink(argc, argv);
    fprintf(stderr, "arena-fs: invalid operation or argument count\n");
    return 2;
}
