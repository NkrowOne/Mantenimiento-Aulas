import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aplicarSeparacion,
  cierresDelRayo,
  separarSinIA,
  separarTodos,
  textoDelRayo,
} from './cierres'
import { configurarIA, separarConIA } from './ia'
import type { ReportData } from './tipos'

/*
 * Los cierres del rayo: la avería y su cierre escritos con una sola frase.
 * Lo que se comprueba es que en el informe salgan como cualquier otro cierre
 * —el problema en la incidencia, lo que se hizo debajo del cierre— y enteros.
 */

const OMAR =
  'No se proyecta pantalla del ordenador del aula Se le indica al usuario por teléfono cómo duplicar la pantalla'

describe('textoDelRayo', () => {
  it('reconoce el cierre que repite el título', () => {
    expect(textoDelRayo(OMAR, OMAR)).toBe(OMAR)
    expect(textoDelRayo('Altavoces sin sonido.', 'altavoces sin sonido')).toBe('altavoces sin sonido')
  })

  it('y el que lo completa por detrás, quedándose con el más largo', () => {
    expect(textoDelRayo('Altavoces sin sonido', 'Altavoces sin sonido. Se conecta la regleta')).toBe(
      'Altavoces sin sonido. Se conecta la regleta',
    )
  })

  it('pero no un cierre normal, ni uno sin explicar', () => {
    expect(textoDelRayo('El ordenador no proyecta', 'Se conectan bien los cables y ya funciona')).toBeNull()
    expect(textoDelRayo('Proyector', 'Se cambia la lámpara del proyector')).toBeNull()
    expect(textoDelRayo('Proyector', null)).toBeNull()
  })
})

describe('separarSinIA', () => {
  it('corta por la puntuación', () => {
    expect(separarSinIA('Los altavoces no funcionan. Se conecta el cable de alimentación a la regleta.')).toEqual({
      problema: 'Los altavoces no funcionan',
      resumen: 'Los altavoces no funcionan',
      solucion: 'Se conecta el cable de alimentación a la regleta.',
    })
  })

  it('y sin puntuación, por la frase de cierre pegada', () => {
    const s = separarSinIA(OMAR)
    expect(s.problema).toBe('No se proyecta pantalla del ordenador del aula')
    expect(s.solucion).toBe('Se le indica al usuario por teléfono cómo duplicar la pantalla')
  })

  it('no parte por un nombre propio ni por el punto de una sala', () => {
    expect(separarSinIA('El proyector del aula 1.7 no enciende, se avisa a Jorge').solucion).toBeNull()
  })

  it('sin por dónde cortar, el problema es el texto entero y no hay solución', () => {
    expect(separarSinIA('cable HDMI suelto')).toEqual({
      problema: 'Cable HDMI suelto',
      resumen: 'Cable HDMI suelto',
      solucion: null,
    })
  })
})

function expediente(): ReportData {
  const evento = (o: Partial<ReportData['eventos'][number]>): ReportData['eventos'][number] => ({
    dia: '2026-10-16',
    hora: '15:42',
    tipo: 'apertura',
    subtipo: 'incidencia',
    titulo: '',
    detalle: null,
    cantidad: null,
    ref: null,
    building: 'H',
    room: '0.5',
    quien: 'Omar Fares',
    ...o,
  })
  return {
    eventos: [
      evento({ tipo: 'cierre', incidencia: 'a', titulo: OMAR, detalle: OMAR }),
      evento({ tipo: 'apertura', incidencia: 'a', titulo: OMAR }),
      evento({
        tipo: 'cierre',
        incidencia: 'b',
        titulo: 'La pantalla del atril no se enciende',
        detalle: 'Se acude al aula y se le explica a la profesora cómo usar el aula',
      }),
      evento({ tipo: 'apertura', incidencia: 'b', titulo: 'La pantalla del atril no se enciende' }),
      evento({ tipo: 'material', titulo: 'Cable HDMI', cantidad: -1 }),
    ],
    cierres: [
      { ref: null, incidencia: 'a', titulo: OMAR, building: 'H', room: '0.5', abierta: '2026-10-16',
        horaAbierta: '15:42', cerrada: '2026-10-16', horaCerrada: '15:42', dias: 0, resolucion: OMAR, quien: null },
    ],
  } as unknown as ReportData
}

describe('aplicarSeparacion', () => {
  it('pone el problema en la incidencia y lo que se hizo bajo el cierre, sin tocar lo demás', () => {
    const d = expediente()
    const textos = cierresDelRayo(d)
    expect([...textos.keys()]).toEqual(['a'])

    const fuera = aplicarSeparacion(d, separarTodos(textos))
    const [cierre, apertura, otroCierre, otraApertura, material] = fuera.eventos

    expect(apertura!.titulo).toBe('No se proyecta pantalla del ordenador del aula')
    expect(cierre!.titulo).toBe('No se proyecta pantalla del ordenador del aula')
    expect(cierre!.detalle).toBe('Se le indica al usuario por teléfono cómo duplicar la pantalla')
    expect(fuera.cierres[0]!.resolucion).toBe('Se le indica al usuario por teléfono cómo duplicar la pantalla')

    expect(otroCierre).toEqual(d.eventos[2])
    expect(otraApertura).toEqual(d.eventos[3])
    expect(material).toEqual(d.eventos[4])
    // Y el expediente de entrada sigue como estaba: lo puede estar leyendo la redacción.
    expect(d.eventos[0]!.titulo).toBe(OMAR)
  })

  it('lo que trae la IA manda sobre la puntuación', () => {
    const d = expediente()
    const ia = new Map([
      ['a', { problema: 'No se proyecta la pantalla del ordenador del aula', resumen: 'No se proyecta la pantalla', solucion: 'Se le indica al usuario por teléfono cómo duplicar la pantalla' }],
    ])
    const fuera = aplicarSeparacion(d, separarTodos(cierresDelRayo(d), ia))
    expect(fuera.eventos[0]!.titulo).toBe('No se proyecta la pantalla')
    expect(fuera.eventos[1]!.titulo).toBe('No se proyecta la pantalla del ordenador del aula')
  })
})

describe('separarConIA', () => {
  afterEach(() => vi.unstubAllGlobals())

  const cfg = configurarIA({ clave: 'clave-de-prueba' })!

  function gemini(respuesta: unknown): { cuerpos: unknown[] } {
    const cuerpos: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      cuerpos.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(respuesta), { status: 200 })
    })
    return { cuerpos }
  }

  it('pide poco razonamiento, ignora el borrador y devuelve por incidencia', async () => {
    const { cuerpos } = gemini({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { thought: true, text: 'pensando… {no es json' },
              {
                text: JSON.stringify({
                  cierres: [
                    { id: '1', problema: 'No se proyecta la pantalla del ordenador del aula.', resumen: 'No se proyecta la pantalla', solucion: 'Se le indica al usuario por teléfono cómo duplicar la pantalla' },
                    // Una cifra que no estaba en el texto: se descarta y va sin IA.
                    { id: '2', problema: 'Los altavoces no funcionan', resumen: 'Altavoces', solucion: 'Se cambian 2 altavoces' },
                  ],
                }),
              },
            ],
          },
        },
      ],
    })

    const { separados, motivo } = await separarConIA(
      new Map([
        ['uuid-a', OMAR],
        ['uuid-b', 'Los altavoces no funcionan se cambian'],
      ]),
      cfg,
    )

    expect(motivo).toBeNull()
    expect(separados.get('uuid-a')).toEqual({
      problema: 'No se proyecta la pantalla del ordenador del aula',
      resumen: 'No se proyecta la pantalla',
      solucion: 'Se le indica al usuario por teléfono cómo duplicar la pantalla',
    })
    expect(separados.has('uuid-b')).toBe(false)

    const cuerpo = cuerpos[0] as { generationConfig: { thinkingConfig: { thinkingLevel: string } } }
    expect(cuerpo.generationConfig.thinkingConfig.thinkingLevel).toBe('low')
  })

  it('si la API dice que no, devuelve el motivo y nada más', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 403 }),
    )
    const { separados, motivo } = await separarConIA(new Map([['a', OMAR]]), cfg)
    expect(separados.size).toBe(0)
    expect(motivo).toBe('API key not valid')
  })
})
