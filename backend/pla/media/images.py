"""Image download, inspection, perceptual hashing and resizing (Pillow)."""
from __future__ import annotations

import io
import math
import os

from PIL import Image, ImageOps

from ..config import LIMITS, ai_limits
from ..storage import commit_file, media_path, remove_quietly, temp_path
from ..web.net import TooLargeError, download_to_file

Image.MAX_IMAGE_PIXELS = 200_000_000

_SIZE = 32
_LOW = 8
_COS = [[math.cos(((2 * x + 1) * u * math.pi) / (2 * _SIZE)) for x in range(_SIZE)] for u in range(_LOW)]

KEEP_FORMATS = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif"}
DUPLICATE_DISTANCE = 6


def _open(source) -> Image.Image:
    return Image.open(io.BytesIO(source)) if isinstance(source, (bytes, bytearray)) else Image.open(source)


def _flatten(image: Image.Image) -> Image.Image:
    """Turns transparency into white, like sharp's flatten({ background: '#ffffff' })."""
    image = ImageOps.exif_transpose(image)
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[3])
        return background
    return image.convert("RGB")


def perceptual_hash(source) -> str:
    """64-bit DCT perceptual hash, as a hex string. Similar images have close hashes."""
    with _open(source) as image:
        small = _flatten(image).resize((_SIZE, _SIZE), Image.BILINEAR).convert("L")
        data = small.tobytes()
    coefficient = [0.0] * (_LOW * _LOW)
    for u in range(_LOW):
        cu = _COS[u]
        for v in range(_LOW):
            cv = _COS[v]
            total = 0.0
            for y in range(_SIZE):
                row = y * _SIZE
                cvy = cv[y]
                for x in range(_SIZE):
                    total += data[row + x] * cu[x] * cvy
            coefficient[u * _LOW + v] = total
    median = sorted(coefficient[1:])[(_LOW * _LOW - 1) // 2]
    value = 0
    for item in coefficient:
        value = (value << 1) | (1 if item > median else 0)
    return f"{value:016x}"


def hamming_distance(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def download_image(product_id: str, urls: list[str]) -> dict:
    """Downloads an image, trying the likely full-size URL first. Format and size come from decoding it."""
    last_error = "no usable URL"
    for url in urls:
        tmp = temp_path(product_id, "images")
        try:
            result = download_to_file(url, tmp, LIMITS.image_max_bytes, 60_000)
            with Image.open(tmp) as image:
                image_format = image.format
                width, height = image.size
                image.load()
            if not image_format:
                remove_quietly(tmp)
                last_error = "not a raster image"
                continue
            if max(width, height) < LIMITS.icon_max_side:
                remove_quietly(tmp)
                last_error = "icon-sized image"
                continue
            phash = perceptual_hash(tmp)
            ext = KEEP_FORMATS.get(image_format)
            size = result["bytes"]
            if not ext:
                converted = temp_path(product_id, "images")
                with Image.open(tmp) as image:
                    _flatten(image).save(converted, "JPEG", quality=92)
                remove_quietly(tmp)
                os.replace(converted, tmp)
                ext = "jpg"
                size = os.path.getsize(tmp)
            return {"status": "ok", "fileName": commit_file(product_id, "images", tmp, ext), "width": width, "height": height, "bytes": size, "phash": phash, "finalUrl": result["finalUrl"]}
        except TooLargeError:
            remove_quietly(tmp)
            return {"status": "too-large", "message": "Image is larger than the 20 MB limit"}
        except Exception as error:  # noqa: BLE001 - any decode or network failure skips this URL
            remove_quietly(tmp)
            last_error = str(error) or error.__class__.__name__
    return {"status": "skip", "reason": last_error}


def inspect_image_file(product_id: str, file_name: str) -> dict:
    file = media_path(product_id, "images", file_name)
    with Image.open(file) as image:
        width, height = image.size
    return {"width": width, "height": height, "bytes": os.path.getsize(file), "phash": perceptual_hash(file)}


def _jpeg(image: Image.Image, side: int, quality: int, flatten: bool = True) -> bytes:
    img = _flatten(image) if flatten else ImageOps.exif_transpose(image).convert("RGB")
    if img.width > side or img.height > side:
        img.thumbnail((side, side), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "JPEG", quality=quality)
    return out.getvalue()


def jpeg_for_lens(source) -> bytes:
    """A JPEG small enough for SerpAPI's image upload, which accepts at most 500 KB."""
    side, quality = 1280, 80
    with _open(source) as image:
        out = _jpeg(image, side, quality)
        while len(out) > 500_000 and side > 480:
            quality = max(50, quality - 10)
            side = round(side * 0.8)
            out = _jpeg(image, side, quality)
    return out


def for_vision(source) -> bytes:
    """Shrinks an image for a Vision request."""
    with _open(source) as image:
        return _jpeg(image, ai_limits()["visionMaxSide"], 82)


def convert_upload(tmp: str) -> tuple[str, str | None]:
    """For uploads: returns (format extension, None) when kept, or ('jpg', converted path) after conversion."""
    with Image.open(tmp) as image:
        image_format = image.format
        image.load()
    if image_format in KEEP_FORMATS:
        return KEEP_FORMATS[image_format], None
    converted = tmp + ".jpg"
    with Image.open(tmp) as image:
        _flatten(image).save(converted, "JPEG", quality=92)
    return "jpg", converted
