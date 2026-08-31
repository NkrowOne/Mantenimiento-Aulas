import { describe, expect, it } from 'vitest'
import {
  codigosAnterioresDeSalaDesdeAuditoria,
  construirIndice,
  contar,
  equivalenciasDesdeAuditoria,
  formasDeEscribir,
  nombresAnterioresDesdeAuditoria,
  proponerEquivalencias,
  resolverSala,
} from './cruce'
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

describe('un alias caducado no puede ganarle al maestro de hoy', () => {
  // La sala A se llamaba `1.1` y pasó a `2.1`, dejando el alias `1.1 CRAI`.
  // Después la sala B pasó a llamarse `1.1`. Nada lo impide: ni `rename_room`
  // ni `create_room` comprueban el código contra `room_aliases`, y de esa tabla
  // no se borra nunca nada.
  const CADUCADO = construirIndice({
    edificios: [{ codigo: 'CRAI', nombre: 'EDIFICIO CRAI', activo: true }],
    salas: [
      sala({ code: '2.1', edificioCodigo: 'CRAI', edificioNombre: 'EDIFICIO CRAI', shortRef: 'SALA-000101', alias: ['1.1 CRAI'] }),
      sala({ code: '1.1', edificioCodigo: 'CRAI', edificioNombre: 'EDIFICIO CRAI', shortRef: 'SALA-000102' }),
    ],
  })

  it('el parte no resuelve la sala que YA NO se llama así: lo declara ambiguo', () => {
    const r = resolverSala(CADUCADO, { tipo: 'parte', ref: '1.1 CRAI' })
    expect(r.estado).toBe('ambigua')
    if (r.estado === 'ambigua') {
      expect(r.candidatas.map((c) => c.shortRef).sort()).toEqual(['SALA-000101', 'SALA-000102'])
    }
  })

  it('la hoja de estado sigue dando la sala que hoy se llama así', () => {
    const r = resolverSala(CADUCADO, { tipo: 'estado', edificio: 'EDIFICIO CRAI', aula: '1.1' })
    expect(r).toMatchObject({ estado: 'resuelta' })
    if (r.estado === 'resuelta') expect(r.sala.shortRef).toBe('SALA-000102')
  })

  it('un alias que apunta a la sala de siempre sigue cruzando por alias', () => {
    const r = resolverSala(CADUCADO, { tipo: 'parte', ref: '2.1 CRAI' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'edificio+codigo' })
  })

  it('dos alias que la base distingue y `norm()` junta: gana el primero, como el servidor', () => {
    // `alias_norm` se escribe con `norm_text`, que NO pasa las comas a puntos;
    // el índice usa `norm()`, que sí. En la base son dos filas distintas y aquí
    // colapsan en la misma clave.
    const ix = construirIndice({
      salas: [
        sala({ code: '9.1', edificioCodigo: 'H', shortRef: 'SALA-000103', alias: ['1,7 H'] }),
        sala({ code: '9.2', edificioCodigo: 'H', shortRef: 'SALA-000104', alias: ['1.7 H'] }),
      ],
    })
    const r = resolverSala(ix, { tipo: 'parte', ref: '1.7 H' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'alias' })
    if (r.estado === 'resuelta') expect(r.sala.shortRef).toBe('SALA-000103')
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

describe('a qué edificio de hoy corresponde un código viejo', () => {
  // `S` es nomenclatura anterior a los renombrados. Nadie sabe de memoria a qué
  // edificio fue a parar, pero las aulas que se nombraron con él sí están en
  // alguna parte, y eso es evidencia y no parecido de nombres.
  const MAESTRO = construirIndice({
    salas: [
      sala({ code: '1.1', edificioCodigo: 'X', edificioNombre: 'EDIFICIO DE LA SALUD' }),
      sala({ code: '1.2', edificioCodigo: 'X', edificioNombre: 'EDIFICIO DE LA SALUD' }),
      sala({ code: '1.3', edificioCodigo: 'X', edificioNombre: 'EDIFICIO DE LA SALUD' }),
      sala({ code: '9.9', edificioCodigo: 'Y', edificioNombre: 'EDIFICIO Y' }),
      // `1.2` también existe en Y: sirve para que la mayoría no sea unanimidad.
      sala({ code: '1.2', edificioCodigo: 'Y', edificioNombre: 'EDIFICIO Y' }),
    ],
  })

  it('si un solo edificio tiene todas las aulas, la equivalencia es la única lectura posible', () => {
    const [eq] = proponerEquivalencias(MAESTRO, [{ codigo: 'S', aulas: ['1.1', '1.2', '1.3'] }])
    expect(eq?.veredicto).toBe('unica')
    expect(eq?.candidatas[0]?.edificioCodigo).toBe('X')
    expect(eq?.candidatas[0]?.aciertos).toBe(3)
  })

  it('mayoría no es unanimidad: si otro edificio también encaja, no elige', () => {
    // `1.2` y `9.9`: X tiene una, Y tiene las dos. Ninguno tiene todas... Y sí.
    const [eq] = proponerEquivalencias(MAESTRO, [{ codigo: 'G', aulas: ['1.2', '9.9'] }])
    expect(eq?.veredicto).toBe('unica')
    expect(eq?.candidatas[0]?.edificioCodigo).toBe('Y')
  })

  it('cuando dos edificios empatan, se propone el ranking y decide una persona', () => {
    const [eq] = proponerEquivalencias(MAESTRO, [{ codigo: 'TM', aulas: ['1.2'] }])
    expect(eq?.veredicto).toBe('ambigua')
    expect(eq?.candidatas).toHaveLength(2)
  })

  it('las aulas que ya no existen no cuentan, pero tampoco tumban la propuesta', () => {
    const [eq] = proponerEquivalencias(MAESTRO, [
      { codigo: 'K', aulas: ['1.1', '1.3', '7.7 QUE YA NO ESTA'] },
    ])
    expect(eq?.aulas).toBe(3)
    expect(eq?.reconocibles).toBe(2)
    expect(eq?.veredicto).toBe('unica')
  })

  it('un código cuyas aulas no existen en ninguna parte se dice, no se adivina', () => {
    const [eq] = proponerEquivalencias(MAESTRO, [{ codigo: 'CEFF', aulas: ['8.1', '8.2'] }])
    expect(eq?.veredicto).toBe('sin_candidata')
    expect(eq?.candidatas).toHaveLength(0)
  })

  it('un parte que escribe «AULA 1.1» habla de la misma aula que el maestro llama `1.1`', () => {
    const [eq] = proponerEquivalencias(MAESTRO, [{ codigo: 'S', aulas: ['AULA 1.1', 'aula 1.3'] }])
    expect(eq?.veredicto).toBe('unica')
    expect(eq?.candidatas[0]?.edificioCodigo).toBe('X')
  })

  it('un edificio no gana por tamaño: cada aula suma una sola vez', () => {
    const grande = construirIndice({
      salas: [
        sala({ code: '1.1', edificioCodigo: 'G', name: 'primera' }),
        // Dos salas del mismo edificio que encajan con la misma aula observada.
        sala({ code: 'AULA 1.1', edificioCodigo: 'G', name: 'segunda' }),
        sala({ code: '2.2', edificioCodigo: 'P' }),
      ],
    })
    const [eq] = proponerEquivalencias(grande, [{ codigo: 'V', aulas: ['1.1'] }])
    expect(eq?.candidatas[0]?.aciertos).toBe(1)
  })
})

describe('las equivalencias declaradas de nomenclatura vieja', () => {
  const MAESTRO: Catalogo = {
    salas: [
      sala({ code: '1.4', edificioCodigo: 'X', edificioNombre: 'EDIFICIO DE LA SALUD' }),
      // Un segundo `1.4`: sin él el maestro es tan pequeño que el último recurso
      // —código único en todo el maestro— resolvería la fila sin equivalencia y
      // la prueba no probaría nada.
      sala({ code: '1.4', edificioCodigo: 'Z', edificioNombre: 'EDIFICIO Z' }),
    ],
    equivalencias: { S: 'X' },
  }
  const IXV = construirIndice(MAESTRO)

  it('un parte que dice `1.4 S` cruza, y dice que se tradujo', () => {
    const r = resolverSala(IXV, { tipo: 'parte', ref: '1.4 S' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'nomenclatura-vieja' })
    if (r.estado === 'resuelta') expect(r.aviso).toContain('nomenclatura vieja')
  })

  it('la hoja de estado también, y tampoco se hace pasar por un cruce normal', () => {
    const r = resolverSala(IXV, { tipo: 'estado', edificio: 'EDIFICIO S', aula: '1.4' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'nomenclatura-vieja' })
  })

  it('sin la línea declarada, la misma fila no cruza: no se adivina', () => {
    const r = resolverSala(construirIndice({ salas: MAESTRO.salas }), { tipo: 'parte', ref: '1.4 S' })
    expect(r.estado).not.toBe('resuelta')
  })

  it('una equivalencia hacia un edificio que no existe se ignora, no traduce hacia la nada', () => {
    const ix = construirIndice({ salas: MAESTRO.salas, equivalencias: { S: 'NO_EXISTE' } })
    expect(ix.equivalencias.size).toBe(0)
    expect(resolverSala(ix, { tipo: 'parte', ref: '1.4 S' }).estado).not.toBe('resuelta')
  })
})

describe('la auditoría sabe lo que pasó, y no hay que deducirlo', () => {
  it('renombrar un edificio deja la equivalencia escrita: misma fila, otro código', () => {
    const eq = equivalenciasDesdeAuditoria({
      vivos: [{ id: 'b1', codigo: 'H' }],
      renombrados: [{ rowId: 'b1', codigoViejo: 'G' }],
      fusiones: [],
      borrados: [],
    })
    expect(eq).toEqual({ G: 'H' })
  })

  it('fusionar deja el salto de las zonas, y el borrado deja el código que tenía al morir', () => {
    const eq = equivalenciasDesdeAuditoria({
      vivos: [{ id: 'b2', codigo: 'CRAI' }],
      renombrados: [],
      fusiones: [{ deId: 'b1', aId: 'b2' }],
      borrados: [{ rowId: 'b1', codigo: 'BC' }],
    })
    expect(eq).toEqual({ BC: 'CRAI' })
  })

  it('una cadena entera apunta al mismo sitio: renombrado dos veces y fusionado después', () => {
    const eq = equivalenciasDesdeAuditoria({
      vivos: [{ id: 'b3', codigo: 'P' }],
      renombrados: [
        { rowId: 'b1', codigoViejo: 'S' },
        { rowId: 'b1', codigoViejo: 'SAL' },
      ],
      fusiones: [
        { deId: 'b1', aId: 'b2' },
        { deId: 'b2', aId: 'b3' },
      ],
      borrados: [{ rowId: 'b1', codigo: 'SALUD' }],
    })
    expect(eq).toEqual({ S: 'P', SAL: 'P', SALUD: 'P' })
  })

  it('un código que sigue vivo hoy no es una equivalencia', () => {
    // `H` se renombró a `X` y luego alguien creó otro edificio `H`. La fila
    // vieja no puede secuestrar un código que hoy es de otro.
    const eq = equivalenciasDesdeAuditoria({
      vivos: [
        { id: 'b1', codigo: 'X' },
        { id: 'b9', codigo: 'H' },
      ],
      renombrados: [{ rowId: 'b1', codigoViejo: 'H' }],
      fusiones: [],
      borrados: [],
    })
    expect(eq).toEqual({})
  })

  it('una cadena que no llega a ningún edificio vivo no inventa un destino', () => {
    const eq = equivalenciasDesdeAuditoria({
      vivos: [],
      renombrados: [],
      fusiones: [{ deId: 'b1', aId: 'b2' }],
      borrados: [{ rowId: 'b1', codigo: 'CEFF' }],
    })
    expect(eq).toEqual({})
  })

  it('un ciclo en la auditoría no cuelga el proceso', () => {
    const eq = equivalenciasDesdeAuditoria({
      vivos: [],
      renombrados: [],
      fusiones: [
        { deId: 'b1', aId: 'b2' },
        { deId: 'b2', aId: 'b1' },
      ],
      borrados: [{ rowId: 'b1', codigo: 'X' }],
    })
    expect(eq).toEqual({})
  })
})

describe('los edificios que existen pero no tienen ni una sala', () => {
  // El importador creó `S`, `G`, `TM`, `BC`, `CC` y `CEFF` como «Edificio X
  // (sin identificar)» al verlos en los partes. La hoja de estado —la única que
  // define salas— no lista ninguna dentro, así que se quedaron vacíos. Un
  // catálogo construido solo desde las salas los pierde.
  const CAT: Catalogo = {
    salas: [
      sala({ code: '0.1P', edificioCodigo: 'P', shortRef: 'SALA-000010' }),
      sala({ code: '9.9', edificioCodigo: 'H', shortRef: 'SALA-000011' }),
      sala({ code: '9.9', edificioCodigo: 'M', shortRef: 'SALA-000012' }),
    ],
    edificios: [
      { codigo: 'P', nombre: 'EDIFICIO P', activo: true },
      { codigo: 'H', nombre: 'EDIFICIO H', activo: true },
      { codigo: 'M', nombre: 'EDIFICIO M', activo: true },
      { codigo: 'S', nombre: 'Edificio S (sin identificar)', activo: true, sinIdentificar: true },
      { codigo: 'CSQ', nombre: 'SIMULACION QUIRURGICA', activo: true },
    ],
  }
  const IXE = construirIndice(CAT)

  it('el índice sabe cuáles están vacíos y cuáles no', () => {
    expect(IXE.edificioVacio.has('S')).toBe(true)
    expect(IXE.edificioVacio.has('P')).toBe(false)
    // Y existen, que es lo que el cruce decía mal cuando el catálogo salía
    // solo de las salas.
    expect(IXE.edificioVivo.has('S')).toBe(true)
  })

  it('un aula de un edificio sin identificar se busca en todo el maestro', () => {
    const r = resolverSala(IXE, { tipo: 'parte', ref: '0.1P S' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'codigo-unico-en-el-maestro' })
    if (r.estado === 'resuelta') expect(r.aviso).toContain('sin identificar')
  })

  it('y si el código se repite, queda ambigua en vez de elegir', () => {
    const r = resolverSala(IXE, { tipo: 'parte', ref: '9.9 S' })
    expect(r.estado).toBe('ambigua')
  })

  it('un edificio vacío pero identificado no manda a buscar por ahí: lo dice y ya', () => {
    const r = resolverSala(IXE, { tipo: 'estado', edificio: 'SIMULACION QUIRURGICA', aula: 'AULA I' })
    expect(r.estado).toBe('sin_cruce')
    if (r.estado === 'sin_cruce') expect(r.motivo).toContain('no tiene ninguna sala')
  })
})

describe('un edificio renombrado en la aplicación sigue cruzando con el libro viejo', () => {
  // El caso real: el edificio `C` se llamaba «EDIFICIO CENTRAL» cuando se
  // escribió el libro y hoy, en la aplicación, se llama «ED. CENTRAL». El
  // edificio es el mismo, con el mismo código y las mismas salas: lo único que
  // cambió fue el rótulo, y sin esto sus diez filas dejan de cruzar de golpe.
  const HOY: Catalogo = {
    edificios: [{ codigo: 'C', nombre: 'ED. CENTRAL', activo: true }],
    salas: [
      sala({ code: '1.2', edificioCodigo: 'C', edificioNombre: 'ED. CENTRAL', shortRef: 'SALA-000003' }),
      sala({ code: '1.2', edificioCodigo: 'M', edificioNombre: 'EDIFICIO M' }),
    ],
    nombresViejos: [{ codigo: 'C', nombre: 'EDIFICIO CENTRAL' }],
  }

  it('la fila que dice «EDIFICIO CENTRAL» encuentra su sala', () => {
    const r = resolverSala(construirIndice(HOY), {
      tipo: 'estado',
      edificio: 'EDIFICIO CENTRAL',
      aula: '1.2',
    })
    expect(r).toMatchObject({ estado: 'resuelta' })
    if (r.estado === 'resuelta') expect(r.sala.shortRef).toBe('SALA-000003')
  })

  it('y dice por qué: el nombre del libro es el anterior, no el de hoy', () => {
    const r = resolverSala(construirIndice(HOY), {
      tipo: 'estado',
      edificio: 'EDIFICIO CENTRAL',
      aula: '1.2',
    })
    if (r.estado !== 'resuelta') throw new Error('tenía que cruzar')
    expect(r.via).toBe('nomenclatura-vieja')
    expect(r.aviso).toContain('nombre anterior')
    expect(r.aviso).toContain('ED. CENTRAL')
  })

  it('sin el nombre anterior la misma fila no cruza: es justo lo que arregla', () => {
    const r = resolverSala(construirIndice({ ...HOY, nombresViejos: [] }), {
      tipo: 'estado',
      edificio: 'EDIFICIO CENTRAL',
      aula: '1.2',
    })
    expect(r.estado).toBe('sin_cruce')
  })

  it('el nombre de hoy sigue cruzando, y sin avisar de nada', () => {
    const r = resolverSala(construirIndice(HOY), { tipo: 'estado', edificio: 'ED. CENTRAL', aula: '1.2' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'edificio+codigo' })
    if (r.estado === 'resuelta') expect(r.aviso).toBeUndefined()
  })

  it('un nombre viejo que hoy lleva otro edificio no se lo puede quedar', () => {
    // `M` se llama hoy «EDIFICIO CENTRAL». Que `C` se llamara así antes no
    // puede llevarse las filas de `M`: el maestro de hoy manda.
    const ix = construirIndice({
      edificios: [
        { codigo: 'C', nombre: 'ED. CENTRAL', activo: true },
        { codigo: 'M', nombre: 'EDIFICIO CENTRAL', activo: true },
      ],
      salas: [
        sala({ code: '1.2', edificioCodigo: 'C', edificioNombre: 'ED. CENTRAL' }),
        sala({ code: '1.2', edificioCodigo: 'M', edificioNombre: 'EDIFICIO CENTRAL', shortRef: 'SALA-M' }),
      ],
      nombresViejos: [{ codigo: 'C', nombre: 'EDIFICIO CENTRAL' }],
    })
    const r = resolverSala(ix, { tipo: 'estado', edificio: 'EDIFICIO CENTRAL', aula: '1.2' })
    if (r.estado !== 'resuelta') throw new Error('tenía que cruzar con M')
    expect(r.sala.shortRef).toBe('SALA-M')
  })

  it('tampoco se queda el nombre de un edificio que desapareció', () => {
    const ix = construirIndice({
      ...HOY,
      edificiosDesaparecidos: [{ codigo: 'CEN', nombre: 'EDIFICIO CENTRAL', motivo: 'fusionado' }],
    })
    expect(ix.nombreAnterior.size).toBe(0)
  })

  it('un nombre anterior de un edificio que ya no existe no se registra', () => {
    const ix = construirIndice({ ...HOY, nombresViejos: [{ codigo: 'NO_EXISTE', nombre: 'LO QUE SEA' }] })
    expect(ix.nombreAnterior.size).toBe(0)
  })
})

describe('los nombres anteriores salen de la auditoría, no de una tabla a mano', () => {
  it('renombrar sin tocar el código deja apuntado el nombre viejo', () => {
    expect(
      nombresAnterioresDesdeAuditoria({
        vivos: [{ id: 'b1', codigo: 'C' }],
        renombrados: [],
        fusiones: [],
        borrados: [],
        nombresCambiados: [{ rowId: 'b1', nombreViejo: 'EDIFICIO CENTRAL' }],
      }),
    ).toEqual([{ codigo: 'C', nombre: 'EDIFICIO CENTRAL' }])
  })

  it('tres renombrados dejan los tres nombres, sin repetir los que se repiten', () => {
    expect(
      nombresAnterioresDesdeAuditoria({
        vivos: [{ id: 'b1', codigo: 'C' }],
        renombrados: [],
        fusiones: [],
        borrados: [],
        nombresCambiados: [
          { rowId: 'b1', nombreViejo: 'EDIFICIO CENTRAL' },
          { rowId: 'b1', nombreViejo: 'CENTRAL' },
          { rowId: 'b1', nombreViejo: 'EDIFICIO CENTRAL' },
        ],
      }),
    ).toEqual([
      { codigo: 'C', nombre: 'EDIFICIO CENTRAL' },
      { codigo: 'C', nombre: 'CENTRAL' },
    ])
  })

  it('si después lo fusionaron, el nombre viejo lleva al edificio que se lo quedó', () => {
    expect(
      nombresAnterioresDesdeAuditoria({
        vivos: [{ id: 'b2', codigo: 'H' }],
        renombrados: [],
        fusiones: [{ deId: 'b1', aId: 'b2' }],
        borrados: [],
        nombresCambiados: [{ rowId: 'b1', nombreViejo: 'EDIFICIO CENTRAL' }],
      }),
    ).toEqual([{ codigo: 'H', nombre: 'EDIFICIO CENTRAL' }])
  })

  it('un rastro que no llega a ningún edificio de hoy no inventa ninguno', () => {
    expect(
      nombresAnterioresDesdeAuditoria({
        vivos: [{ id: 'b9', codigo: 'Z' }],
        renombrados: [],
        fusiones: [],
        borrados: [],
        nombresCambiados: [{ rowId: 'b1', nombreViejo: 'EDIFICIO CENTRAL' }],
      }),
    ).toEqual([])
  })

  it('sin renombrados de nombre no hay nada que apuntar', () => {
    expect(
      nombresAnterioresDesdeAuditoria({
        vivos: [{ id: 'b1', codigo: 'C' }],
        renombrados: [{ rowId: 'b1', codigoViejo: 'CEN' }],
        fusiones: [],
        borrados: [],
      }),
    ).toEqual([])
  })
})

describe('las nueve aulas de sótano del CRAI', () => {
  // El caso real, y las tres cosas que le pasaron encima:
  //
  //  1. el libro las escribe con el menos DETRÁS —`1.1-`—, que es como el
  //     importador las creó y como quedó su alias: `1.1- CRAI`;
  //  2. alguien las renombró en la aplicación a `-1.1` … `-1.9`;
  //  3. y después fusionó el CRAI con el T. Moro.
  //
  // El alias siguió en la base y siguió apuntando a la sala correcta. Lo que
  // dejó de servir fue su forma: lleva pegado el código del edificio de aquel
  // día, y el cruce lo recomponía con el de hoy.
  //
  // Se arma desde el rastro de la auditoría a propósito, y no escribiendo la
  // equivalencia a mano: así la prueba cubre también que la fusión se reconoce.
  const RASTRO = {
    vivos: [{ id: 'tm', codigo: 'TM' }],
    renombrados: [],
    fusiones: [{ deId: 'crai', aId: 'tm' }],
    borrados: [{ rowId: 'crai', codigo: 'CRAI' }],
  }

  const NUEVE = [1, 2, 3, 4, 5, 6, 7, 8, 9]

  const CATALOGO_CRAI: Catalogo = {
    edificios: [{ codigo: 'TM', nombre: 'Edificio TM', activo: true }],
    salas: NUEVE.map((n) =>
      sala({
        code: `-1.${n}`,
        edificioCodigo: 'TM',
        edificioNombre: 'Edificio TM',
        shortRef: `SALA-00020${n}`,
        alias: [`1.${n}- CRAI`],
      }),
    ),
    equivalencias: equivalenciasDesdeAuditoria(RASTRO),
  }

  const IXC = construirIndice(CATALOGO_CRAI)

  it('la auditoría reconoce la fusión sin que nadie la declare', () => {
    expect(equivalenciasDesdeAuditoria(RASTRO)).toEqual({ CRAI: 'TM' })
  })

  it.each(NUEVE)('la fila «1.%i-» de «EDIFICIO CRAI» encuentra su sala', (n) => {
    const r = resolverSala(IXC, { tipo: 'estado', edificio: 'EDIFICIO CRAI', zona: 'PLANTA -1', aula: `1.${n}-` })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'alias' })
    if (r.estado === 'resuelta') expect(r.sala.code).toBe(`-1.${n}`)
  })

  it('y dice que el alias se guardó con el código de antes', () => {
    const r = resolverSala(IXC, { tipo: 'estado', edificio: 'EDIFICIO CRAI', aula: '1.1-' })
    if (r.estado !== 'resuelta') throw new Error('tenía que cruzar')
    expect(r.aviso).toContain('1.1- CRAI')
  })

  it('sin la equivalencia de la fusión no cruza, y por eso hace falta la lápida', () => {
    const ix = construirIndice({ ...CATALOGO_CRAI, equivalencias: {} })
    const r = resolverSala(ix, { tipo: 'estado', edificio: 'EDIFICIO CRAI', aula: '1.1-' })
    expect(r.estado).not.toBe('resuelta')
  })

  it('sin el alias, el código anterior de la auditoría la rescata igual', () => {
    const ix = construirIndice({
      ...CATALOGO_CRAI,
      salas: CATALOGO_CRAI.salas.map((s) => ({ ...s, alias: [] })),
      codigosViejosDeSala: codigosAnterioresDeSalaDesdeAuditoria({
        ...RASTRO,
        salasRenombradas: NUEVE.map((n) => ({ rowId: `id-TM--1.${n}`, codigoViejo: `1.${n}-` })),
      }),
    })
    const r = resolverSala(ix, { tipo: 'estado', edificio: 'EDIFICIO CRAI', aula: '1.4-' })
    expect(r).toMatchObject({ estado: 'resuelta', via: 'codigo-anterior-de-sala' })
    if (r.estado === 'resuelta') expect(r.sala.code).toBe('-1.4')
  })

  it('el código de hoy manda sobre el de ayer: no se secuestra una sala viva', () => {
    // La sala A se llamaba `-1.1` y pasó a `-1.9`; después la sala B pasó a
    // llamarse `-1.1`. La fila que dice `-1.1` es de B, que es como se llama hoy.
    const ix = construirIndice({
      edificios: [{ codigo: 'TM', nombre: 'Edificio TM', activo: true }],
      salas: [
        sala({ code: '-1.9', edificioCodigo: 'TM', shortRef: 'SALA-A', id: 'sala-a' }),
        sala({ code: '-1.1', edificioCodigo: 'TM', shortRef: 'SALA-B', id: 'sala-b' }),
      ],
      codigosViejosDeSala: [{ salaId: 'sala-a', codigo: '-1.1' }],
    })
    const r = resolverSala(ix, { tipo: 'estado', edificio: 'TM', aula: '-1.1' })
    if (r.estado !== 'resuelta') throw new Error('tenía que cruzar')
    expect(r.sala.shortRef).toBe('SALA-B')
  })

  it('un código anterior nunca sale a buscar por todo el campus', () => {
    // Es la trampa que hay que evitar: `1.1-` del CRAI y `-1.1` del EDIFICIO H
    // son aulas de sótano distintas, de edificios distintos. El código anterior
    // vive dentro de su edificio y no entra en `porCodigoSuelto`.
    const ix = construirIndice({
      edificios: [
        { codigo: 'TM', nombre: 'Edificio TM', activo: true },
        { codigo: 'H', nombre: 'EDIFICIO H', activo: true },
      ],
      salas: [
        sala({ code: '-1.1', edificioCodigo: 'TM', shortRef: 'SALA-TM', id: 'sala-tm' }),
        sala({ code: '-1.1', edificioCodigo: 'H', shortRef: 'SALA-H', id: 'sala-h' }),
      ],
      codigosViejosDeSala: [{ salaId: 'sala-tm', codigo: '1.1-' }],
    })
    expect(ix.porCodigoSuelto.get('1.1-')).toBeUndefined()
    // Y con un edificio que ya no está, tampoco lo encuentra por ahí.
    const r = resolverSala(ix, { tipo: 'estado', edificio: 'EDIFICIO QUE NO EXISTE', aula: '1.1-' })
    expect(r.estado).not.toBe('resuelta')
  })
})
