"""Render the extension icons: a bridge arch on a blue gradient tile.

Run it only when the icon design changes:
    <bundled python> edge-bridge/tools/make-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4

TOP = (77, 107, 254)
BOTTOM = (44, 60, 217)


def rounded_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def quadratic(p0, p1, p2, steps=120):
    points = []
    for index in range(steps + 1):
        t = index / steps
        u = 1 - t
        points.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return points


def render(size: int) -> Image.Image:
    scale = size * SUPERSAMPLE
    canvas = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))

    gradient = Image.new("RGB", (1, scale))
    for y in range(scale):
        t = y / max(1, scale - 1)
        gradient.putpixel((0, y), tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)))
    gradient = gradient.resize((scale, scale))

    tile = Image.new("RGBA", (scale, scale))
    tile.paste(gradient, (0, 0))
    tile.putalpha(rounded_mask(scale, scale * 0.24))
    canvas.alpha_composite(tile)

    draw = ImageDraw.Draw(canvas)
    width = max(2, round(scale * 0.085))
    arch = quadratic((0.12, 0.70), (0.30, 0.33), (0.50, 0.35)) + quadratic(
        (0.50, 0.35), (0.70, 0.37), (0.88, 0.58)
    )
    draw.line([(x * scale, y * scale) for x, y in arch], fill=(255, 255, 255, 255), width=width, joint="curve")

    dot = scale * 0.062
    for cx, cy in ((0.12, 0.70), (0.88, 0.58)):
        draw.ellipse(
            (cx * scale - dot, cy * scale - dot, cx * scale + dot, cy * scale + dot),
            fill=(255, 255, 255, 255),
        )

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        render(size).save(OUT / f"icon-{size}.png")
        print(f"wrote {OUT / f'icon-{size}.png'}")


if __name__ == "__main__":
    main()