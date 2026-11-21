import base64
import binascii
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile

from PIL import Image, ImageOps


ARCHIVE_LIMIT = 1024**3
MIN_FREE_DISK = 1024**3
AUDIO_SUFFIXES = {
    b"audio/wav": "wav", b"audio/wave": "wav", b"audio/x-wav": "wav",
    b"audio/mpeg": "mp3", b"audio/mp3": "mp3", b"audio/flac": "flac",
    b"audio/ogg": "ogg", b"audio/webm": "webm", b"audio/mp4": "m4a",
    b"audio/x-m4a": "m4a", b"audio/aac": "aac", b"audio/opus": "opus",
}
ARCHIVE_NAME = re.compile(r"[0-9a-f]{64}\.(png|jpeg|webp|gif|" + "|".join(sorted(set(AUDIO_SUFFIXES.values()))) + ")")
THREAD_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
CHECKSUM = re.compile(r"[0-9a-f]{64}")
INLINE_MEDIA = re.compile(rb"data:((?:image|audio)/[^,;\x22\s]+);base64,([a-zA-Z0-9+/=]+)")
archive = None


@contextmanager
def archive_lock():
    with (archive / ".archive.lock").open("a+b") as lock:
        if os.name == "nt":
            import msvcrt

            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        yield


def make_room(incoming):
    entries = []
    used = 0
    for file in archive.iterdir():
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode):
            continue
        used += info.st_size
        if ARCHIVE_NAME.fullmatch(file.name):
            entries.append((info.st_mtime_ns, file.name, file, info.st_size))
    if used + incoming > ARCHIVE_LIMIT:
        # Count the incoming bytes toward the post-cleanup size.
        for _, _, file, size in sorted(entries):
            if used + incoming <= ARCHIVE_LIMIT // 2:
                break
            try:
                with file.open("rb") as cached:
                    if hashlib.file_digest(cached, "sha256").hexdigest() != file.stem:
                        continue
                file.unlink()
            except OSError:
                continue
            used -= size
    return used + incoming <= ARCHIVE_LIMIT


def original(raw, suffix, digest=None):
    if archive is None:
        return None
    digest = digest or hashlib.sha256(raw).hexdigest()
    path = archive / f"{digest}.{suffix}"
    try:
        if path.is_file():
            return path.as_posix() if hashlib.sha256(path.read_bytes()).hexdigest() == digest else None
        if len(raw) > ARCHIVE_LIMIT:
            return None
        with archive_lock():
            if path.is_file():
                return path.as_posix() if hashlib.sha256(path.read_bytes()).hexdigest() == digest else None
            if not make_room(len(raw)) or len(raw) > shutil.disk_usage(archive).free - MIN_FREE_DISK:
                return None
            with tempfile.NamedTemporaryFile(dir=archive, suffix=".tmp", delete=False) as file:
                pending = Path(file.name)
                try:
                    file.write(raw)
                    file.close()
                    pending.replace(path)
                finally:
                    file.close()
                    pending.unlink(missing_ok=True)
        return path.as_posix()
    except OSError:
        return None


def open_archive(directory):
    global archive
    if not directory:
        return
    try:
        candidate = Path(directory)
        candidate.mkdir(parents=True, exist_ok=True)
        archive = candidate.resolve(strict=True)
        with archive_lock():
            make_room(0)
    except OSError:
        archive = None


def session_records(codex_root, thread_id):
    root = Path(codex_root).resolve(strict=True)
    for folder, pattern in (
        (root / "sessions", f"????/??/??/rollout-*-{thread_id}.jsonl"),
        (root / "archived_sessions", f"rollout-*-{thread_id}.jsonl"),
    ):
        for record in folder.glob(pattern):
            if record.resolve().is_relative_to(root) and record.is_file():
                yield record


def restore(codex_root, thread_id, digest):
    if not THREAD_ID.fullmatch(thread_id) or not CHECKSUM.fullmatch(digest):
        return {"error": "Invalid Codex thread ID or media checksum"}
    if archive is None:
        return {"error": "Media cache is unavailable"}
    try:
        for candidate in archive.glob(f"{digest}.*"):
            if ARCHIVE_NAME.fullmatch(candidate.name) and candidate.is_file():
                with candidate.open("rb") as cached:
                    if hashlib.file_digest(cached, "sha256").hexdigest() == digest:
                        return {"path": candidate.as_posix(), "source": "cache"}
        for record in session_records(codex_root, thread_id):
            with record.open("rb") as history:
                for line in history:
                    for match in INLINE_MEDIA.finditer(line):
                        try:
                            raw = base64.b64decode(match[2], validate=True)
                        except binascii.Error:
                            continue
                        if hashlib.sha256(raw).hexdigest() != digest:
                            continue
                        suffix = AUDIO_SUFFIXES.get(match[1])
                        if suffix is None:
                            if not match[1].startswith(b"image/"):
                                continue
                            with Image.open(io.BytesIO(raw), formats=("PNG", "JPEG", "WEBP", "GIF")) as image:
                                suffix = image.format.lower()
                        path = original(raw, suffix, digest)
                        if path:
                            return {"path": path, "source": "codex_history"}
                        return {"error": "Found the original in Codex history but could not save it to the cache"}
    except OSError:
        return {"error": "Could not read the local Codex record or media cache"}
    return {"error": "The original media is no longer embedded in this Codex thread's local record"}


def prepare(line):
    operation, _, image_url = line.rstrip(b"\r\n").partition(b" ")
    header, _, payload = image_url.partition(b",")
    if not header.startswith((b"data:image/", b"data:audio/")) or not header.endswith(b";base64"):
        return None
    try:
        raw = base64.b64decode(payload, validate=True)
        if header.startswith(b"data:audio/"):
            suffix = AUDIO_SUFFIXES.get(header[5:-7])
            if not suffix or not raw:
                return None
            digest = hashlib.sha256(raw).hexdigest()
            return {"path": original(raw, suffix, digest), "sha256": digest}
        with Image.open(io.BytesIO(raw), formats=("PNG", "JPEG", "WEBP", "GIF")) as image:
            digest = hashlib.sha256(raw).hexdigest()
            path = original(raw, image.format.lower(), digest)
            reference = {"path": path, "sha256": digest}
            if image.width * image.height > 40_000_000:
                return reference
            if operation != b"1":
                return reference
            oriented = ImageOps.exif_transpose(image)
            oriented.thumbnail((768, 768), Image.Resampling.LANCZOS)
            if "A" in oriented.getbands() or "transparency" in oriented.info:
                rgba = oriented.convert("RGBA")
                canvas = Image.new("RGB", rgba.size, "white")
                canvas.paste(rgba, mask=rgba.getchannel("A"))
            else:
                canvas = oriented.convert("RGB")
            for edge, quality in ((768, 78), (768, 65), (576, 64), (384, 60)):
                canvas.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                buffer = io.BytesIO()
                canvas.save(buffer, "JPEG", quality=quality)
                if buffer.tell() <= 95_970:
                    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
                    return {**reference, "url": "data:image/jpeg;base64," + encoded}
            return reference
    except (OSError, ValueError, binascii.Error, Image.DecompressionBombError):
        return None
    return None


if __name__ == "__main__":
    if len(sys.argv) == 6 and sys.argv[1] == "--restore":
        open_archive(sys.argv[2])
        result = restore(*sys.argv[3:])
        json.dump(result, sys.stdout)
        sys.exit(1 if "error" in result else 0)
    open_archive(sys.argv[1])
    prepared = [prepare(line) for line in sys.stdin.buffer]
    # A later archive write in this batch can evict an older image.
    for entry in prepared:
        if entry and entry.get("path") and not Path(entry["path"]).is_file():
            entry["path"] = None
    json.dump(prepared, sys.stdout, separators=(",", ":"))
