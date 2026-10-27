"""
What the worker accepts as input (task L-12): a cut-out of the machine on a
transparent background, made by our own cut-out step (L-03).

TRELLIS.2 removes the background itself only when the image has none
removed already: an image whose alpha channel holds any transparency is
used as it is (`preprocess_image` in Microsoft's pipeline). Sending our own
cut-out (segment.py) therefore skips TRELLIS.2's matting, so the only
background remover that sees a customer's photo is the one our step runs.
The image is passed on unchanged, so Microsoft's own resizing and cropping
still apply.

An image that is not a usable cut-out is refused with a reason, rather
than handed to a background remover.
"""
from __future__ import annotations

from PIL import Image

# TRELLIS.2 crops to the pixels more than 80 % opaque.
SOLID = int(0.8 * 255)
# Below this share of solid pixels there is no machine to model.
MIN_SUBJECT = 0.01
# Above this share, the background was not taken away.
MAX_SUBJECT = 0.95


class CutoutError(ValueError):
    pass


def check_cutout(image: Image.Image) -> Image.Image:
    """Returns `image` if it is a cut-out TRELLIS.2 will use as it is; raises CutoutError otherwise."""
    if image.mode != "RGBA":
        raise CutoutError(f"The image is {image.mode}, not a cut-out: send RGBA with the background transparent.")
    alpha = image.getchannel("A")
    counts = alpha.histogram()
    total = image.width * image.height
    if counts[255] == total:
        raise CutoutError("The image has an alpha channel but nothing is transparent: send the cut-out, not the photo.")
    solid = sum(counts[SOLID + 1 :]) / total
    if solid < MIN_SUBJECT:
        raise CutoutError(f"Only {solid:.1%} of the image is the machine: the cut-out is empty.")
    if solid > MAX_SUBJECT:
        raise CutoutError(f"{solid:.1%} of the image is solid: the background was not removed.")
    return image
