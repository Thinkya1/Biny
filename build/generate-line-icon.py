#!/usr/bin/env python3
"""Wrap the monochrome portrait in a borderless rounded macOS icon canvas."""

import sys

from PIL import Image, ImageDraw, ImageOps


def main(source: str, output: str) -> None:
    illustration = Image.open(source).convert("RGBA")
    grayscale = ImageOps.grayscale(illustration)
    alpha = ImageOps.invert(grayscale).point(lambda value: min(255, value * 4))
    illustration.putalpha(alpha)
    illustration = illustration.resize((810, 810), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).rounded_rectangle((18, 18, 1006, 1006), radius=208, fill="white")
    canvas.alpha_composite(illustration, (107, 107))
    canvas.save(output)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
