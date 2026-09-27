# Host-owned, bounded dependency observation. Never import candidate code.
import hashlib
import json
import os
import stat
import sys
import time
from collections import OrderedDict

root, expected_dev, expected_ino, roots_json, milliseconds = sys.argv[1:]
deadline = time.monotonic() + int(milliseconds) / 1000
root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
initial_root = os.fstat(root_fd)
if (initial_root.st_dev, initial_root.st_ino) != (int(expected_dev), int(expected_ino)):
    raise RuntimeError('workspace replaced')
cache = OrderedDict()
directories = {'': initial_root}
output_bytes = 0
entry_count = 0

def check_time():
    if time.monotonic() >= deadline:
        raise RuntimeError('deadline')

def directory_identity(observed):
    return observed.st_dev, observed.st_ino, observed.st_mode, observed.st_uid, observed.st_gid

def signature(observed):
    return (*directory_identity(observed), observed.st_size, observed.st_mtime_ns, observed.st_ctime_ns)

def directory(path):
    check_time()
    if not path:
        return os.dup(root_fd)
    if path in cache:
        cache.move_to_end(path)
        return os.dup(cache[path])
    parent, _, name = path.rpartition('/')
    parent_fd = directory(parent)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)
    observed = os.fstat(fd)
    previous = directories.setdefault(path, observed)
    if len(directories) > 250_000:
        raise RuntimeError('directory limit')
    if signature(previous) != signature(observed):
        os.close(fd)
        raise RuntimeError('directory replaced')
    cache[path] = fd
    if len(cache) > 128:
        _, expired = cache.popitem(last=False)
        os.close(expired)
    return os.dup(fd)

def emit(relative, observed, kind, target='', content=''):
    global output_bytes
    fields = [root + '/' + relative, str(observed.st_dev), str(observed.st_ino),
              format(stat.S_IMODE(observed.st_mode), 'o'), str(observed.st_size),
              str(observed.st_mtime_ns), str(observed.st_ctime_ns), kind, target, content,
              str(observed.st_uid), str(observed.st_gid)]
    raw = b'\0'.join(os.fsencode(value) for value in fields) + b'\0'
    output_bytes += len(raw)
    if output_bytes > 64 * 1024 * 1024:
        raise RuntimeError('output limit')
    sys.stdout.buffer.write(raw)

def walk(relative):
    global entry_count
    check_time()
    entry_count += 1
    if entry_count > 500_000 or relative.count('/') > 128:
        raise RuntimeError('traversal limit')
    parent, _, name = relative.rpartition('/')
    parent_fd = directory(parent)
    try:
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if stat.S_ISLNK(before.st_mode):
            target = os.readlink(name, dir_fd=parent_fd)
            if signature(before) != signature(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)):
                raise RuntimeError('symlink changed')
            emit(relative, before, 'l', target)
        elif stat.S_ISREG(before.st_mode):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
            try:
                if signature(before) != signature(os.fstat(fd)):
                    raise RuntimeError('file replaced')
                digest = hashlib.sha256()
                while True:
                    check_time()
                    block = os.read(fd, 1024 * 1024)
                    if not block:
                        break
                    digest.update(block)
                after = os.fstat(fd)
                if signature(before) != signature(after):
                    raise RuntimeError('file changed during read')
                if signature(after) != signature(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)):
                    raise RuntimeError('file entry replaced')
                emit(relative, before, 'f', content=digest.hexdigest())
            finally:
                os.close(fd)
        elif stat.S_ISDIR(before.st_mode):
            fd = directory(relative)
            try:
                if signature(before) != signature(os.fstat(fd)):
                    raise RuntimeError('directory replaced')
                emit(relative, before, 'd')
                with os.scandir(fd) as entries:
                    for entry in entries:
                        walk(relative + '/' + entry.name)
            finally:
                os.close(fd)
        else:
            raise RuntimeError('unsupported entry')
    finally:
        os.close(parent_fd)

try:
    for absolute in json.loads(roots_json):
        if not absolute.startswith(root + '/'):
            raise RuntimeError('external root')
        relative = absolute[len(root) + 1:]
        if any(part in ('', '.', '..') for part in relative.split('/')):
            raise RuntimeError('invalid root')
        walk(relative)
    # Reopen ancestry from the pinned root instead of trusting cached descriptors.
    for fd in cache.values():
        os.close(fd)
    cache.clear()
    for path in list(directories):
        fd = directory(path)
        os.close(fd)
    if signature(os.stat(root, follow_symlinks=False)) != signature(initial_root):
        raise RuntimeError('workspace replaced')
    check_time()
finally:
    for fd in cache.values():
        os.close(fd)
    os.close(root_fd)
