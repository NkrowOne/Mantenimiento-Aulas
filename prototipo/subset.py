#!/usr/bin/env python3
"""Genera los subconjuntos de fuente que incrusta el prototipo.

    pip install fonttools brotli
    python3 prototipo/subset.py /ruta/a/los/ttf

Recorta Instrument Sans e IBM Plex Mono al latino más los signos castellanos
que la página usa realmente: 38 KB las cuatro variantes en lugar de 400 KB.

Se conserva `kern`. Sin él aparecen huecos dentro de las palabras
("Alt avoces", "Micró fono"), porque Instrument Sans confía el ajuste de
pares a la tabla GPOS. Comprobado renderizando, no suponiendo.
"""
import pathlib
import sys

from fontTools.subset import main as subset

DEST = pathlib.Path(__file__).parent / "fuentes"
SRC = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

# Latino + castellano + los signos tipográficos que aparecen en la página
CHARS = (
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    "áéíóúüñÁÉÍÓÚÜÑ¿¡ª°º"
    " .,:;!?()[]{}/\\|-_+=<>*#%&@'\"$"
)
# comillas latinas, guiones, menos matemático, punto medio, puntos suspensivos, flecha
EXTRA = [
    "U+00AB", "U+00BB", "U+2018", "U+2019", "U+201C", "U+201D",
    "U+2013", "U+2014", "U+2212", "U+00B7", "U+2022", "U+2026",
    "U+2039", "U+203A", "U+00A0", "U+2192",
]

FACES = [
    ("sans-r", "InstrumentSans-Regular.ttf"),
    ("sans-b", "InstrumentSans-Bold.ttf"),
    ("mono-r", "IBMPlexMono-Regular.ttf"),
    ("mono-b", "IBMPlexMono-Bold.ttf"),
]

DEST.mkdir(parents=True, exist_ok=True)
total = 0
for name, filename in FACES:
    out = DEST / f"{name}.woff2"
    subset([
        str(SRC / filename),
        f"--text={CHARS}",
        "--unicodes=" + ",".join(EXTRA),
        "--flavor=woff2",
        "--layout-features=kern",
        f"--output-file={out}",
    ])
    size = out.stat().st_size
    total += size
    print(f"{name}: {size / 1024:.1f} KB")
print(f"TOTAL: {total / 1024:.1f} KB")
