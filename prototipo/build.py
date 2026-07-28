#!/usr/bin/env python3
"""Compone el prototipo autocontenido incrustando las fuentes en el HTML.

    python3 prototipo/build.py

Lee `index.src.html` y sustituye los marcadores __SANS_R__, __SANS_B__,
__MONO_R__ y __MONO_B__ por las fuentes de `fuentes/` codificadas en base64.
El resultado, `index.html`, no depende de red ni de CDN.

Para regenerar los subconjuntos de fuente desde los originales, ver subset.py.
"""
import base64
import pathlib

HERE = pathlib.Path(__file__).parent
FACES = {
    "__SANS_R__": "sans-r.woff2",
    "__SANS_B__": "sans-b.woff2",
    "__MONO_R__": "mono-r.woff2",
    "__MONO_B__": "mono-b.woff2",
}

src = (HERE / "index.src.html").read_text(encoding="utf-8")
for token, filename in FACES.items():
    if token not in src:
        raise SystemExit(f"Falta el marcador {token} en index.src.html")
    data = (HERE / "fuentes" / filename).read_bytes()
    src = src.replace(token, base64.b64encode(data).decode())

doc = (
    '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    "<style>*{margin:0;padding:0}</style>\n</head>\n<body>\n"
    + src
    + "\n</body>\n</html>\n"
)
out = HERE / "index.html"
out.write_text(doc, encoding="utf-8")
print(f"{out.relative_to(HERE.parent)}: {len(doc) // 1024} KB")
