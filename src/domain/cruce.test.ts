import { describe, expect, it } from 'vitest'
import { construirIndice, contar, formasDeEscribir, resolverSala } from './cruce'
import type { Catalogo, SalaConocida } from './cruce'

function sala(p: Partial<SalaConocida> & { code: string; edificioCodigo: string }): SalaConocida {
  return {
    id: `id-${p.edificioCodigo}-${p.code}`,
    shortRef: p.shortRef ?? `SALA-${p.edificioCodigo}${p.code}`,
    name: p.name ?? p.code,
    active: p.active ?? true,
    zona: p.zona ?? 'PLANTA BAJA',
    edificioNombre: p.edificioNombre ?? `EDIFICIO ${p.edificioCodigo}`,
    edificioActivo: p.edificioActivo ?? true,
    alias: p.alias ?? [],
    ...p,
  }
}

/** Un maestro pequeño con las formas reales de nombrar del Excel. */
const CATALOGO: Catalogo = {
  salas: [
    sala({ code: '0.1P', edificioCodigo: 'P', shortRef: 'SALA-000001', alias: ['0.1P P', '0.1 P'] }),
    sala({ code: '1.7', edificioCodigo: 'H', shortRef: 'SALA-000002', alias: ['1.7 H'] }),
    sala({ code: '1.2', edificioCodigo: 'C', edificioNombre: 'EDIFICIO CENTRAL', shortRef: 'SALA-000003' }),
    sala({ code: '5.4 (Lab 3D)', edificioCodigo: 'C', edificioNombre: 'EDIFICIO CENTRAL', shortRef: 'SALA-000004' }),
    sala({ code: 'Aula 6', edificioCodigo: 'CD', edificioNombre: 'CENTRO DEPORTIVO', shortRef: 'SALA-000005' }),
    sala({ code: '2.3', edificioCodigo: 'E', shortRef: 'SALA-000006' }),
    // Un código que se repite en dos edificios: el caso que hace ambigua la
    // búsqueda sin edificio.
    sala({ code: '1.4', edificioCodigo: 'H', shortRef: 'SALA-000007' }),
    sala({ code: '1.4', edificioCodigo: 'M', shortRef: 'SALA-000008' }),
  ],
  edificiosDesaparecidos: [{ codigo: 'CRAI', nombre: 'EDIFICIO CRAI', motivo: 'fusionado' }],
}

const IX = construirIndice(CATALOGO)

describe('la matrícula manda sobre todo lo demás', () => {
  it('cruza por SALA-nnnnnn aunque la sala se haya renombrado', () => {
    const r = resolverSala(IX, { tipo: 'matricula', ref: 'SALA-000002' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'matricula' })
  })

  it('una matrícula que no existe no se inventa una sala parecida', () => {
    const r = resolverSala(IX, { tipo: 'matricula', ref: 'SALA-999999' })
    expect(r.estado).toBe('sin_cruce')
  })
})

describe('los alias son donde viven los renombrados', () => {
  it('`1.7 H` cruza por alias, que es lo que deja rename_room', () => {
    const r = resolverSala(IX, { tipo: 'parte', ref: '1.7 H' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'alias' })
  })

  it('`Sotano -1.5 BC` sin sala conocida dice por qué, no falla en silencio', () => {
    const r = resolverSala(IX, { tipo: 'parte', ref: 'Sotano -1.5 BC' })
    expect(r.estado).toBe('sin_cruce')
    if (r.estado === 'sin_cruce') expect(r.motivo).toContain('BC')
  })

  it('el EDIFICIO P escribe `0.1P` y el parte `0.1 P`: cruzan igual', () => {
    const r = resolverSala(IX, { tipo: 'parte', ref: '0.1 P' })
    expect(r).toMatchObject({ estado: 'resuelta' })
    if (r.estado === 'resuelta') expect(r.sala.shortRef).toBe('SALA-000001')
  })
})

describe('la hoja de estado', () => {
  it('cruza edificio y código tal cual vienen', () => {
    const r = resolverSala(IX, { tipo: 'estado', edificio: 'EDIFICIO P', zona: 'PLANTA BAJA', aula: '0.1P' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'edificio+codigo' })
  })

  it('«EDIFICO E» es una errata conocida, no un edificio nuevo', () => {
    const r = resolverSala(IX, { tipo: 'estado', edificio: 'EDIFICO E', aula: '2.3' })
    expect(r).toMatchObject({ estado: 'resuelta' })
    if (r.estado === 'resuelta') expect(r.sala.shortRef).toBe('SALA-000006')
  })

  it('« EDIFICIO CENTRAL» con espacio delante cruza igual', () => {
    const r = resolverSala(IX, { tipo: 'estado', edificio: ' EDIFICIO CENTRAL ', aula: '1.2' })
    expect(r).toMatchObject({ estado: 'resuelta' })
  })

  it('`5.4 (Lab 3D)` cruza también escrito sin el paréntesis', () => {
    const r = resolverSala(IX, { tipo: 'estado', edificio: 'EDIFICIO CENTRAL', aula: '5.4' })
    expect(r).toMatchObject({ estado: 'resuelta' })
    if (r.estado === 'resuelta') expect(r.sala.shortRef).toBe('SALA-000004')
  })
})

describe('el libro de revisión nombra los edificios por su código', () => {
  it('«Edificio C» es EDIFICIO CENTRAL', () => {
    const r = resolverSala(IX, { tipo: 'revision', edificio: 'Edificio C', nombreAula: 'AULA 1.2' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'edificio+nombre' })
    if (r.estado === 'resuelta') expect(r.sala.shortRef).toBe('SALA-000003')
  })

  it('«AULA 1.2» y «1.2» son la misma sala', () => {
    const conPalabra = resolverSala(IX, { tipo: 'revision', edificio: 'Edificio C', nombreAula: 'AULA 1.2' })
    const sinPalabra = resolverSala(IX, { tipo: 'revision', edificio: 'Edificio C', nombreAula: '1.2' })
    expect(conPalabra).toMatchObject({ estado: 'resuelta' })
    expect(sinPalabra).toMatchObject({ estado: 'resuelta' })
  })

  it('un edificio que el maestro no conoce se dice, no se adivina', () => {
    const r = resolverSala(IX, { tipo: 'revision', edificio: 'Edificio G', nombreAula: 'AULA -1.1' })
    expect(r.estado).toBe('sin_cruce')
    if (r.estado === 'sin_cruce') expect(r.motivo).toContain('Edificio G')
  })
})

describe('lo que las migraciones se llevaron por delante', () => {
  it('un edificio fusionado se explica, y la sala se encuentra si el código es único', () => {
    const r = resolverSala(IX, { tipo: 'estado', edificio: 'EDIFICIO CRAI', aula: '2.3' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'codigo-unico-en-el-maestro' })
    if (r.estado === 'resuelta') expect(r.aviso).toContain('fusionado')
  })

  it('si el código se repite, no elige por su cuenta: lo deja ambiguo', () => {
    const r = resolverSala(IX, { tipo: 'estado', edificio: 'EDIFICIO CRAI', aula: '1.4' })
    expect(r.estado).toBe('ambigua')
    if (r.estado === 'ambigua') expect(r.candidatas).toHaveLength(2)
  })

  it('una sala archivada cruza, pero lo avisa', () => {
    const cat: Catalogo = { salas: [sala({ code: '9.9', edificioCodigo: 'H', active: false })] }
    const r = resolverSala(construirIndice(cat), { tipo: 'estado', edificio: 'EDIFICIO H', aula: '9.9' })
    expect(r).toMatchObject({ estado: 'resuelta' })
    if (r.estado === 'resuelta') expect(r.aviso).toContain('archivada')
  })

  it('un edificio en la papelera también avisa', () => {
    const cat: Catalogo = { salas: [sala({ code: '9.9', edificioCodigo: 'H', edificioActivo: false })] }
    const r = resolverSala(construirIndice(cat), { tipo: 'estado', edificio: 'EDIFICIO H', aula: '9.9' })
    expect(r).toMatchObject({ estado: 'resuelta' })
    if (r.estado === 'resuelta') expect(r.aviso).toContain('papelera')
  })
})

describe('el recuento', () => {
  it('separa resueltas, ambiguas y sin cruce', () => {
    const res = [
      resolverSala(IX, { tipo: 'matricula', ref: 'SALA-000002' }),
      resolverSala(IX, { tipo: 'estado', edificio: 'EDIFICIO CRAI', aula: '1.4' }),
      resolverSala(IX, { tipo: 'revision', edificio: 'Edificio G', nombreAula: 'AULA -1.1' }),
    ]
    expect(contar(res)).toMatchObject({ total: 3, resueltas: 1, ambiguas: 1, sinCruce: 1 })
  })
})

describe('las formas de escribir un código se componen', () => {
  it('«AULA -2.1 - LAB. DE LA SALUD» llega hasta `-2.1`', () => {
    expect(formasDeEscribir('AULA -2.1 - LAB. DE LA SALUD')).toContain('-2.1')
  })

  it('«AULA 4.1 (Alta)» llega hasta `4.1`', () => {
    expect(formasDeEscribir('AULA 4.1 (Alta)')).toContain('4.1')
  })

  it('un sótano no se parte por su propio guion', () => {
    expect(formasDeEscribir('-1.1')).toEqual(['-1.1'])
  })

  it('quita la letra del edificio pegada al código', () => {
    expect(formasDeEscribir('0.1P', 'P')).toContain('0.1')
  })
})
