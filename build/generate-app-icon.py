#!/usr/bin/env python3
"""Create a white-canvas macOS icon from a centered portrait."""

from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def main(source: str, output: str) -> None:
    original = cv2.imread(source, cv2.IMREAD_COLOR)
    if original is None:
        raise SystemExit(f"Unable to read {source}")

    height, width = original.shape[:2]
    mask = np.full((height, width), cv2.GC_BGD, dtype=np.uint8)
    mask[0:590, 70:745] = cv2.GC_PR_FGD
    mask[500:height, 45:790] = cv2.GC_PR_FGD
    mask[:, 790:width] = cv2.GC_BGD
    mask[0:height, 0:16] = cv2.GC_BGD

    background = np.zeros((1, 65), np.float64)
    foreground = np.zeros((1, 65), np.float64)
    cv2.grabCut(original, mask, None, background, foreground, 6, cv2.GC_INIT_WITH_MASK)
    alpha = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    alpha[:12, :] = 0

    rgba = cv2.cvtColor(original, cv2.COLOR_BGR2RGBA)
    rgba[:, :, 3] = alpha
    portrait = Image.fromarray(rgba).resize((790, 790), Image.Resampling.LANCZOS)
    portrait.putalpha(portrait.getchannel("A").filter(ImageFilter.GaussianBlur(1.2)))

    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).rounded_rectangle((18, 18, 1006, 1006), radius=208, fill="white")
    canvas.alpha_composite(portrait, (117, 117))
    canvas.save(output)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
