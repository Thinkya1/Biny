#!/usr/bin/env python3
"""Add a restrained, dock-legible nose stroke to the approved line illustration."""

import sys

from PIL import Image, ImageDraw


def main(source: str, output: str) -> None:
    image = Image.open(source).convert("RGBA")
    draw = ImageDraw.Draw(image)
    draw.line(((621, 596), (616, 616), (627, 623)), fill="black", width=6, joint="curve")
    image.save(output)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
