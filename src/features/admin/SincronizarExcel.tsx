import { useMutation, useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { construirIndice } from '@/domain/cruce'
import { prepararHojaDeEstado } from '@/domain/preparar'
import type { Preparacion } from '@/domain/preparar'
import { abrirLibro, leerHoja, parchear } from '@/domain/xlsx'
import type { Libro } from '@/domain/xlsx'
import { catalogoDelMaestro } from './catalogoDelMaestro'

const HOJA = 'Estado Aulas y Salas de reunion'

/**
 * Preparar el Excel de SharePoint para que se pueda sincronizar.
 *
 * Es la vía que no necesita permiso de nadie: se sube el `.xlsx`, se ve **qué
 * pasaría antes de que pase**, y se descarga el mismo fichero con la columna de
 * matrículas ya escrita. El viaje de vuelta a SharePoint lo hace una persona.
 *
 * Tres cosas que esta pantalla promete y conviene que se lean aquí:
 *
 * **El fichero no sale de este ordenador.** Se abre, se cruza y se parchea en el
 * navegador. No se sube a ningún sitio, ni al servidor de la aplicación.
 *
 * **No se escribe nada en la base de datos.** Esto solo prepara el libro. Que
 * las correcciones del Excel entren en la base es el paso siguiente, y necesita
 * la instantánea de la fusión a tres bandas para poder distinguir quién cambió
 * qué.
 *
 * **El libro vuelve intacto.** No se regenera: se reescriben las celdas de la
 * columna nueva y todo lo demás se copia con sus bytes. Sobreviven las fórmulas,
 * los formatos condicionales, el autofiltro, la fila inmovilizada, los
 * comentarios, la etiqueta de confidencialidad y los metadatos de SharePoint —
 * que es justo lo que se pierde al regenerar el libro con una librería.
 */
export function SincronizarExcel(): React.ReactElement {
  const entrada = useRef<HTMLInputElement>(null)
  const [nombre, setNombre] = useState<string | null>(null)
  const [libro, setLibro] = useState<Libro | null>(null)
  const [plan, setPlan] = useState<Preparacion | null>(null)
  const [fallo, setFallo] = useState<string | null>(null)
  const [descargado, setDescargado] = useState(false)

  const { data: catalogo, isPending: cargandoMaestro } = useQuery({
    queryKey: ['maestro', 'catalogo'],
    queryFn: catalogoDelMaestro,
    staleTime: 60_000,
  })

  const analizar = useMutation({
    mutationFn: async (fichero: File) => {
      if (!catalogo) throw new Error('El maestro de salas todavía no ha cargado')
      const bytes = new Uint8Array(await fichero.arrayBuffer())
      const l = await abrirLibro(bytes)
      if (!l.hojas.some((h) => h.nombre === HOJA)) {
        throw new Error(
          `Este libro no tiene la hoja «${HOJA}». Sus hojas son: ${l.hojas.map((h) => h.nombre).join(', ')}`,
        )
      }
      const filas = await leerHoja(l, HOJA)
      return { libro: l, plan: prepararHojaDeEstado(filas, construirIndice(catalogo)) }
    },
    onSuccess: (r) => {
      setLibro(r.libro)
      setPlan(r.plan)
      setFallo(null)
      setDescargado(false)
    },
    onError: (e: Error) => {
      setLibro(null)
      setPlan(null)
      setFallo(e.message)
    },
  })

  const descargar = useMutation({
    mutationFn: async () => {
      if (!libro || !plan) return
      const bytes = await parchear(libro, [{ hoja: HOJA, celdas: plan.cambios }])
      // El nombre lleva sufijo a propósito: el fichero que se sube a SharePoint
      // lo elige una persona, y sobreescribir el original sin querer desde la
      // carpeta de descargas es la clase de accidente que no se deshace.
      const base = (nombre ?? 'libro.xlsx').replace(/\.xlsx$/i, '')
      // `Uint8Array` sobre un `ArrayBuffer` normal: el tipo de Blob no acepta
      // los respaldados por `SharedArrayBuffer`.
      const blob = new Blob([bytes as unknown as BlobPart], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${base} (con referencias).xlsx`
      a.click()
      URL.revokeObjectURL(url)
      setDescargado(true)
    },
  })

  const limpiar = (): void => {
    setLibro(null)
    setPlan(null)
    setFallo(null)
    setNombre(null)
    setDescargado(false)
    if (entrada.current) entrada.current.value = ''
  }

  return (
    <section>
      <h1 className="text-xl font-semibold">Preparar el Excel de SharePoint</h1>
      <p className="mt-1 text-sm text-muted">
        Escribe en el libro la matrícula de cada aula, que es lo que permite reconocer cada fila
        aunque se ordene, se filtre o se inserten filas encima. El fichero no sale de este
        ordenador y no se toca la base de datos.
      </p>

      <div className="card mt-4 p-4">
        <input
          ref={entrada}
          type="file"
          accept=".xlsx"
          disabled={cargandoMaestro || analizar.isPending}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            setNombre(f.name)
            analizar.mutate(f)
          }}
          className="block w-full text-sm file:mr-3 file:h-10 file:rounded-ctl file:border-0 file:bg-accent-fill file:px-4 file:font-semibold file:text-accent-ink"
        />
        <p className="mt-2 text-xs text-muted">
          {cargandoMaestro
            ? 'Cargando el maestro de salas…'
            : analizar.isPending
              ? 'Leyendo el libro…'
              : `Se mira la hoja «${HOJA}».`}
        </p>
      </div>

      {fallo && (
        <p className="mt-3 rounded-ctl bg-crit-fill p-3 text-sm text-crit-ink">{fallo}</p>
      )}

      {plan && <Resumen plan={plan} nombre={nombre} />}

      {plan && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="key key-accent h-11 px-4"
            disabled={plan.cambios.length === 0 || descargar.isPending}
            onClick={() => descargar.mutate()}
          >
            {plan.cambios.length === 0
              ? 'No hay nada que escribir'
              : `Descargar el libro con ${plan.escrituras.length} matrículas`}
          </button>
          <button type="button" className="key key-quiet h-11 px-4" onClick={limpiar}>
            Empezar de nuevo
          </button>
          {descargado && (
            <span className="text-sm text-muted">
              Descargado. Súbelo a SharePoint sustituyendo el original.
            </span>
          )}
        </div>
      )}
    </section>
  )
}

function Resumen({ plan, nombre }: { plan: Preparacion; nombre: string | null }): React.ReactElement {
  const problemas = plan.ambiguas.length + plan.sinCruce.length + plan.discrepan.length

  return (
    <div className="mt-4 space-y-4">
      <div className="card p-4">
        <p className="eyebrow">{nombre}</p>
        <p className="mt-2 text-sm">
          <strong>{plan.total}</strong> aulas en la hoja. Se escribirían{' '}
          <strong>{plan.escrituras.length}</strong> matrículas en la columna{' '}
          <strong>{plan.columna}</strong>
          {plan.yaCorrectas > 0 && <> y {plan.yaCorrectas} ya la tenían bien</>}.
        </p>
        <p className="mt-2 text-xs text-muted">
          La columna va al final y no la primera: insertarla a la izquierda desplazaría todas las
          demás y habría que reescribir cada fórmula, el rango del autofiltro y los formatos
          condicionales. Al final no desplaza nada.
        </p>
        {problemas === 0 && plan.total > 0 && (
          <p className="mt-2 text-sm text-ok-ink">Todas las filas cruzan con el maestro.</p>
        )}
      </div>

      {plan.escrituras.length > 0 && (
        <Detalle titulo={`Se escribirá (${plan.escrituras.length})`} abierto={false}>
          <Tabla
            cabeceras={['Celda', 'Aula', 'Matrícula']}
            filas={plan.escrituras.map((e) => [e.celda, e.aula, e.valor])}
          />
        </Detalle>
      )}

      {plan.discrepan.length > 0 && (
        <Detalle titulo={`Ya tenían otra matrícula (${plan.discrepan.length})`} abierto>
          <p className="mb-2 text-sm text-muted">
            No se tocan. Puede que alguien las corrigiera a mano sabiendo algo que el cruce no
            sabe, o que el cruce se equivoque: pisarlas borraría la única señal de que hay un
            desacuerdo.
          </p>
          <Tabla
            cabeceras={['Celda', 'Aula', 'Dice', 'Saldría']}
            filas={plan.discrepan.map((e) => [e.celda, e.aula, e.actual, e.valor])}
          />
        </Detalle>
      )}

      {plan.ambiguas.length > 0 && (
        <Detalle titulo={`Ambiguas (${plan.ambiguas.length})`} abierto>
          <p className="mb-2 text-sm text-muted">
            El código encaja con más de una sala. No se elige por cuenta propia.
          </p>
          <Tabla
            cabeceras={['Fila', 'Edificio', 'Aula', 'Por qué']}
            filas={plan.ambiguas.map((a) => [String(a.fila), a.edificio, a.aula, a.motivo])}
          />
        </Detalle>
      )}

      {plan.sinCruce.length > 0 && (
        <Detalle titulo={`Sin cruce (${plan.sinCruce.length})`} abierto>
          <Tabla
            cabeceras={['Fila', 'Edificio', 'Aula', 'Por qué']}
            filas={plan.sinCruce.map((a) => [String(a.fila), a.edificio, a.aula, a.motivo])}
          />
        </Detalle>
      )}
    </div>
  )
}

function Detalle({
  titulo,
  abierto,
  children,
}: {
  titulo: string
  abierto: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <details className="card p-4" open={abierto}>
      <summary className="cursor-pointer text-sm font-semibold">{titulo}</summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}

function Tabla({
  cabeceras,
  filas,
}: {
  cabeceras: string[]
  filas: string[][]
}): React.ReactElement {
  // Se enseñan las primeras y se dice cuántas quedan: una tabla de 276 filas
  // dentro de una pantalla de administración no la lee nadie, y hacerla scroll
  // infinito esconde el resumen, que es lo que de verdad hay que mirar.
  const tope = 25
  return (
    <div className="scroll-x">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {cabeceras.map((c) => (
              <th key={c} className="eyebrow pb-1 pr-4">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.slice(0, tope).map((f, i) => (
            <tr key={i} className="border-t border-line">
              {f.map((celda, j) => (
                <td key={j} className="py-1 pr-4 font-mono text-xs">
                  {celda}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {filas.length > tope && (
        <p className="mt-2 text-xs text-muted">y {filas.length - tope} más</p>
      )}
    </div>
  )
}
