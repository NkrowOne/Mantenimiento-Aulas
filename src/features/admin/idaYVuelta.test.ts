/**
 * Ida y vuelta: la segunda pasada seguida no escribe nada.
 *
 * Es una de las dos pruebas que corren sobre el libro de verdad, y por eso hace
 * falta darle uno: `LIBRO_XLSX=…/Material_Aulas.xlsx npm test`. Sin esa
 * variable se salta, porque el libro no está en el repositorio —lleva dentro el
 * parque entero con nombres y números de serie— y una prueba que exige un
 * fichero que nadie tiene es una prueba roja para todo el mundo.
 *
 * Lo que comprueba es lo que más cuesta ver a ojo: sincronizar dos veces
 * seguidas contra los mismos datos tiene que dejar el libro quieto la segunda.
 * Si la segunda pasada escribe una sola celda, hay un valor que va y vuelve
 * —una fecha que se lee distinta de como se escribe, un blanco arrastrado que
 * se confunde con un hueco— y a la décima pasada el libro es otro. Encontró
 * cuatro así, y son cuatro que ninguna prueba de unidad iba a encontrar: las
 * cuatro necesitaban las 276 filas reales.
 *
 * `SALIDA=…/algo` guarda los dos ficheros para mirarlos con Excel cuando falla.
 *
 * Ojo con lo que NO dice: idempotente no quiere decir correcto. Un destrozo
 * estable pasa esta prueba tan campante —las fórmulas escritas como texto la
 * pasaban—, así que esto descarta el vaivén, no el estropicio. Para el
 * estropicio está `divergencia.test.ts`, que cambia la aplicación y mira dónde
 * cae cada cambio.
 *
 * El lado «aplicación» lo construye `espejoDelLibro.ts`, compartido con la otra
 * prueba: dos copias del espejo eran dos formas de leer el libro, y una de las
 * dos no sabía que «EDIFICO E» es «EDIFICIO E».
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { abrirLibro, leerHoja } from '@/domain/xlsx'
import { BOLSA_2025, BOLSA_2026, ESTADO, MATERIAL_2025, MATERIAL_2026 } from '@/domain/mapa'
import { escribir as escribirPasada } from '@/features/admin/pasada'
import type { Analisis } from '@/features/admin/pasada'
import type { Plan } from '@/domain/sincronizar'
import { datosDelLibro, formaDe, instantaneaDe, pasada, vaivenesDe } from './espejoDelLibro'

const RUTA = process.env.LIBRO_XLSX
const SALIDA = process.env.SALIDA

const datosPasada = (_planes: Plan[]) => ({
  revisiones: [
    {
      shortRef: 'SALA-000001',
      edificio: 'EDIFICIO H',
      zona: '1ª PLANTA',
      sala: '1.7',
      cuando: '2026-03-04T09:30:00Z',
      quien: 'Ana',
      estado: 'cerrada',
      resultado: 'ok',
      horasProyector: 4200,
      lampara: 0.86,
      comprobaciones: 'altavoces: ok',
      incidenciasAbiertas: 0,
      notas: 'Todo bien',
    },
  ],
  movimientos: [
    {
      cuando: '2026-02-01',
      articulo: 'Cable HDMI',
      cantidad: -2,
      tipo: 'consumo',
      incidencia: 'I260102_0007',
      sala: '1.7',
      quien: 'Ana',
      nota: null,
    },
  ],
  equipos: [
    {
      shortRef: 'SALA-000001',
      edificio: 'EDIFICIO H',
      zona: '1ª PLANTA',
      sala: '1.7',
      tipo: 'Proyector',
      modelo: 'EB-1985',
      serial: '0340985RL',
      estado: 'activo',
      desde: '2024-01-01',
      etiqueta: null,
    },
  ],
})

/** La forma del libro sin el parte de la pasada, que cuenta lo que hizo cada una. */
const sinParte = (f: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(f).filter(([h]) => h !== 'Sincronización'))

describe.skipIf(!RUTA)('ida y vuelta', () => {
  it('la segunda pasada seguida no escribe nada', async () => {
    const bytes0 = new Uint8Array(readFileSync(RUTA!))
    const libro0 = await abrirLibro(bytes0)
    const datos = datosDelLibro(
      await leerHoja(libro0, ESTADO.nombre),
      await leerHoja(libro0, MATERIAL_2026.nombre),
      await leerHoja(libro0, BOLSA_2026.nombre),
      { mat: await leerHoja(libro0, MATERIAL_2025.nombre), bolsa: await leerHoja(libro0, BOLSA_2025.nombre) },
    )

    // ---- Pasada 1: la que pone el libro al día. Escribe, y tiene que escribir.
    const p1 = await pasada(bytes0, datos, () => undefined)
    const a1 = { libro: p1.libro, planes: p1.planes, hojasNuevas: [], datos: datosPasada(p1.planes) } as unknown as Analisis
    const bytes1 = await escribirPasada(a1, '2026-08-30 10:00')
    if (SALIDA) writeFileSync(`${SALIDA}-1.xlsx`, bytes1)

    // ---- Pasada 2 sobre lo que salió de la 1, con los mismos datos y la
    // instantánea que dejó. Aquí no queda nada que hacer.
    const p2 = await pasada(bytes1, datos, instantaneaDe(p1.planes))

    // Lo que se escribiría en la segunda, celda a celda y con su porqué: si
    // esto falla, lo primero que hace falta es saber QUÉ va y vuelve.
    expect(vaivenesDe(p2.planes).slice(0, 40)).toEqual([])

    // Y el libro que sale de la segunda tiene que tener la misma forma que el
    // de la primera. No basta con que el plan esté vacío: las hojas de detalle
    // no van por el plan —se rehacen enteras cada pasada— así que un fallo ahí
    // no aparece en ninguna celda propuesta. Y hubo uno: se insertaban las filas
    // nuevas sin borrar las viejas, y «Sincronización» pasaba de 336 filas a
    // 671 y a 1.006, con el mismo contenido repetido.
    //
    // El parte de la pasada queda fuera a propósito: cuenta lo que hizo cada
    // una, y la primera hace cosas —cruzar por serial, devolver una fórmula—
    // que la segunda ya no tiene que hacer.
    const a2 = { libro: p2.libro, planes: p2.planes, hojasNuevas: [], datos: datosPasada(p2.planes) } as unknown as Analisis
    const bytes2 = await escribirPasada(a2, '2026-08-30 11:00')
    if (SALIDA) writeFileSync(`${SALIDA}-2.xlsx`, bytes2)

    expect(sinParte(await formaDe(bytes2))).toEqual(sinParte(await formaDe(bytes1)))
  }, 300_000)
})
