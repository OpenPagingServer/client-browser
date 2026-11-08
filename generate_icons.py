"""Regenerate Chrome PNG icons from the desktop application's embedded OPS icon."""
from base64 import b64decode
from io import BytesIO
from pathlib import Path
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import embedded_assets

output = Path(__file__).resolve().parent / "icons"
output.mkdir(exist_ok=True)
source = Image.open(BytesIO(b64decode(embedded_assets.APP_ICO))).convert("RGBA")
for size in (16, 32, 48, 128):
    source.resize((size, size), Image.Resampling.LANCZOS).save(output / f"icon{size}.png")
