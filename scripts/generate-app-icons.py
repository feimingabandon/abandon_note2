from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "design" / "icon-preview" / "abandon-note-moonwhite-cat-02-transparent.png"
BUILD_DIR = ROOT / "build"
RUNTIME_DIR = ROOT / "resources"


def rounded_icon(source: Image.Image, size: int) -> Image.Image:
    icon = source.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)

    # Keep the artwork's rounded-square silhouette while making the corners truly
    # transparent for Windows shortcuts, the taskbar, and macOS packaging.
    scale = 4
    mask = Image.new("L", (size * scale, size * scale), 0)
    draw = ImageDraw.Draw(mask)
    radius = round(size * 0.105 * scale)
    draw.rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1),
        radius=radius,
        fill=255,
    )
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    # Preserve transparency already present in the master artwork, then apply
    # the platform-safe rounded-square mask as an additional upper bound.
    mask = ImageChops.multiply(icon.getchannel("A"), mask)
    icon.putalpha(mask)
    return icon


def main() -> None:
    source = Image.open(SOURCE)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

    png_512 = rounded_icon(source, 512)
    png_512.save(BUILD_DIR / "icon.png", optimize=True)
    png_512.save(RUNTIME_DIR / "icon.png", optimize=True)

    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    png_512.save(BUILD_DIR / "icon.ico", format="ICO", sizes=ico_sizes)

    png_1024 = rounded_icon(source, 1024)
    png_1024.save(BUILD_DIR / "icon.icns", format="ICNS")


if __name__ == "__main__":
    main()
