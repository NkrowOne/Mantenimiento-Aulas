import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { RoomPlate } from '@/components/RoomPlate'
import { TriState } from '@/components/TriState'
import { RoomInventory } from '@/features/inventory/RoomInventory'
import { PHOTO_ACCEPT, capturePhoto } from '@/lib/photos'
import { db } from '@/db/dexie'
import { type CheckKey, type Room, type Severity } from '@/domain/types'
import { displayRoomCode } from '@/domain/normalize'
import { useInspection } from './useInspection'

interface Props {
  room: Room
  userId: string | null
  buildingName: string
  /** Nombre de la planta o módulo. Sin esto, «-2.1» se lee como un sótano. */
  zoneName: string
  onDone: (nextRoom: boolean) => void
  onBack: () => void
  /** Abrir la ficha de la sala desde la placa, sin salir del flujo. */
  onFicha: () => void
}

const SEVERITIES: Array<{ value: Severity; label: string }> = [
  { value: 'baja', label: 'Leve' },
  { value: 'media', label: 'Molesta' },
  { value: 'alta', label: 'Impide la clase' },
]

export function InspectionPage({
  room,
  userId,
  buildingName,
  zoneName,
  onDone,
  onBack,
  onFicha,
}: Props): React.ReactElement {
  const { draft, rows, assets, types, typesById, saving, setCheck, setNotes, markRestOk, complete } =
    useInspection(room, userId)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [subiendoFoto, setSubiendoFoto] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const filas = useRef<HTMLDivElement>(null)

  /*
   * Las fotos se cuentan desde los adjuntos, no desde un contador en memoria.
   * Antes era `useState(0)`: salir de la sala y volver lo reiniciaba, y sobre
   * una revisión que ya tenía foto reaparecía «Añade una foto de la incidencia».
   */
  const photoCount =
    useLiveQuery(
      async () =>
        draft
          ? db.attachments
              .where('[entity_type+entity_id]')
              .equals(['inspection', draft.inspection.id])
              .count()
          : 0,
      [draft?.inspection.id],
    ) ?? 0

  if (!draft) {
    return <p className="p-6 text-muted">Preparando…</p>
  }

  const missing = rows.filter((row) => !draft.checks.get(row.key))
  const incidents = [...draft.checks.values()].filter((c) => c.result === 'incidencia')
  const needsPhoto = incidents.length > 0 && photoCount === 0

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    if (!file || !draft) return
    setPhotoError(null)

    // Comprimir varios megapíxeles tarda. Sin esta señal el botón se quedaba
    // mudo y el técnico volvía a pulsarlo pensando que no había cogido la foto.
    setSubiendoFoto(true)
    const result = await capturePhoto(file, 'inspection', draft.inspection.id)
    setSubiendoFoto(false)

    if (!result.ok) setPhotoError(result.error ?? 'No se pudo guardar la foto.')
    if (fileInput.current) fileInput.current.value = ''
  }

  return (
    <div className="pb-44">
      <RoomPlate
        building={buildingName}
        zone={zoneName}
        title={room.name === room.code ? `Sala ${displayRoomCode(room.code)}` : room.name}
        code={displayRoomCode(room.code)}
        onBack={onBack}
        onFicha={onFicha}
      />

      {/* Revisión por excepción: primero la vía rápida, y solo se baja al
          detalle quien tenga algo que reportar.

          Se queda montado y colapsa en vez de desaparecer: al pulsarlo se va y
          la lista entera saltaba setenta píxeles hacia arriba, justo debajo del
          dedo. `inert` lo saca del orden de tabulación mientras está cerrado. */}
      <div
        className="collapse-y"
        data-open={draft.checks.size === 0 && rows.length > 0}
        inert={draft.checks.size > 0}
      >
        <div>
          <div className="px-4 pt-4">
            {/*
              Al pulsarlo, `markRestOk` deja el propio contenedor del botón en
              `inert` y el navegador desenfoca su descendiente sin reubicar el
              foco: acababa en <body>, y el siguiente tabulador reempezaba desde
              la cabecera. Se manda el foco a la lista, que es donde sigue el
              trabajo.
            */}
            <button
              type="button"
              onClick={() => {
                markRestOk()
                filas.current?.focus()
              }}
              className="key key-ok flex h-touch w-full items-center justify-center gap-2"
            >
              <span aria-hidden className="text-lg">✓</span>
              {draft.checks.size === 0
                ? 'Todo correcto'
                : `Marcar OK las ${missing.length} restantes`}
            </button>
          </div>
        </div>
      </div>

      <div ref={filas} tabIndex={-1} className="divide-y divide-line px-4 outline-none">
        {rows.map((row) => {
          const key = row.key
          const check = draft.checks.get(key)
          const measure = row.measure

          return (
            <div
              key={key}
              /*
                Cuando hay incidencia, la fila y su detalle son UN panel con un
                borde y un radio. Antes eran dos formas apiladas —fila teñida
                cuadrada y caja redondeada encima— y el marco cojeaba.
              */
              className={
                check?.result === 'incidencia'
                  ? '-mx-1 my-2 rounded-ctl border border-crit/25 bg-crit-tint px-3'
                  : ''
              }
            >
              <TriState
                label={row.label}
                hint={row.hint}
                /* Naranja mientras nadie lo valida, y usable igual: bloquear la
                   revisión hasta que alguien apruebe un nombre sería el camino
                   más corto a que el equipo deje de apuntar lo que encuentra. */
                flag={row.pending ? 'Sin validar' : null}
                value={check?.result ?? null}
                onChange={(result) => setCheck(key, result)}
              />

              {/* El detalle de la incidencia se despliega, no aparece de golpe.
                  Marcar «Falla» insertaba de repente ochenta píxeles en mitad de
                  la lista y todo lo de abajo se teleportaba. */}
              {/* El contenido se monta al marcar «Falla», no en las nueve filas
                  a la vez. Antes cada revisión llevaba nueve bloques de gravedad
                  y nueve textarea montados para que se usara, como mucho, uno. */}
              <div className="collapse-y" data-open={check?.result === 'incidencia'}>
                <div>
                  {check?.result === 'incidencia' && (
                  <div className="pb-3">
                    <p className="eyebrow mb-2">Gravedad</p>
                    <div className="grid grid-cols-3 gap-2">
                      {SEVERITIES.map((s) => (
                        <button
                          key={s.value}
                          type="button"
                          onClick={() => setCheck(key, 'incidencia', { severity: s.value })}
                          className={`key min-h-11 px-2 text-xs ${
                            check?.severity === s.value ? 'key-crit' : 'key-quiet text-muted'
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>

                    {/* Estado local y guardado al salir del campo: escribir
                        cuarenta caracteres disparaba cuarenta re-renders de la
                        revisión entera y cuarenta reprogramaciones del guardado. */}
                    <NotaIncidencia
                      value={check?.note ?? ''}
                      onCommit={(note) => setCheck(key, 'incidencia', { note })}
                    />
                  </div>
                  )}
                </div>
              </div>

              {check?.result === 'ok' && measure && (
                <label className="mb-4 flex items-center gap-3 text-sm">
                  <span className="text-muted">{measure.label}</span>
                  {/*
                    `type="text"` y no `type="number"` a propósito. Con `number`,
                    el teclado español da coma y el navegador devuelve cadena
                    vacía para «94,3»: se guardaba `null` con el número todavía
                    visible en pantalla. Aquí se acepta coma o punto y se convierte.
                  */}
                  <input
                    type="text"
                    inputMode="decimal"
                    enterKeyHint="done"
                    value={check.measure ?? ''}
                    onChange={(e) => {
                      const limpio = e.target.value.replace(',', '.').trim()
                      const n = Number(limpio)
                      setCheck(key, 'ok', {
                        measure: limpio === '' || Number.isNaN(n) ? null : n,
                        measure_unit: measure.unit,
                      })
                    }}
                    className="h-11 w-24 rounded-ctl border border-line bg-surface px-2 text-right font-mono tabular"
                  />
                  <span className="text-muted">{measure.unit}</span>
                </label>
              )}
            </div>
          )
        })}
      </div>

      {/* El inventario, aquí y no en otra pantalla: el momento en que alguien
          descubre que está mal es estando delante del aparato. */}
      <RoomInventory
        roomId={room.id}
        userId={userId}
        assets={assets}
        types={types}
        typesById={typesById}
      />

      <div className="border-t border-line px-4">
        <div className="py-4">
          <p className="eyebrow mb-2">Fotos y observaciones</p>

          <input
            ref={fileInput}
            type="file"
            accept={PHOTO_ACCEPT}
            onChange={(e) => void onPickPhoto(e)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={subiendoFoto}
            className="key flex h-touch w-full items-center justify-center gap-2 border-2 border-dashed border-line bg-transparent text-muted shadow-none"
          >
            <span aria-hidden className="text-lg leading-none">+</span>
            {subiendoFoto
              ? 'Procesando la foto…'
              : photoCount > 0
                ? `${photoCount} foto${photoCount === 1 ? '' : 's'} · añadir otra`
                : 'Añadir foto'}
          </button>

          {photoError && <p className="mt-2 text-sm text-crit">{photoError}</p>}
          {needsPhoto && (
            <p className="mt-2 text-sm text-warn">Añade una foto de la incidencia.</p>
          )}

          <TextoLargo
            value={draft.inspection.notes ?? ''}
            onCommit={setNotes}
            placeholder="Observaciones (opcional)"
            rows={3}
            className="mt-3 w-full rounded-ctl border border-line bg-surface p-3 text-sm"
            label="Observaciones de la revisión"
          />
        </div>
      </div>

      {/* Barra fija: el pulgar la encuentra sin mirar, y respeta la zona de
          gestos del iPhone. */}
      <div
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface px-4 py-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <div className="mb-2 flex items-center justify-between gap-3 text-xs">
          {/*
            El acelerador vive aquí, no arriba del todo.
            «Marcar OK las N restantes» estaba en la cabecera y el aviso de que
            faltaban, abajo: el técnico leía el problema en un extremo de la
            pantalla y tenía que estirarse al otro para resolverlo. Ahora la
            misma franja que dice qué falta ofrece cómo resolverlo.
          */}
          {missing.length === 0 ? (
            <span className="text-muted">Todo comprobado</span>
          ) : draft.checks.size === 0 ? (
            // Nada marcado todavía: la vía rápida es el botón grande de arriba,
            // y repetirla aquí solo añadiría una segunda forma de hacer lo mismo.
            <span className="text-muted">
              Faltan {missing.length} comprobacion{missing.length === 1 ? '' : 'es'}
            </span>
          ) : (
            <button
              type="button"
              onClick={markRestOk}
              className="key key-quiet min-h-11 px-3 text-xs"
            >
              Faltan {missing.length} · marcar OK
            </button>
          )}
          {/* `role="status"` porque es LA respuesta a «¿se ha guardado?»: un
              lector de pantalla debe anunciarlo sin que nadie lo busque. */}
          <span role="status" className="shrink-0 text-muted">
            {saving ? 'Guardando…' : 'Guardado'}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            disabled={missing.length > 0}
            onClick={() => void complete().then(() => onDone(false))}
            className="key key-quiet h-touch flex-1"
          >
            Guardar
          </button>
          <button
            type="button"
            disabled={missing.length > 0}
            onClick={() => void complete().then(() => onDone(true))}
            className="key key-accent h-touch flex-[2]"
          >
            Guardar y siguiente sala
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Campo de texto que no re-renderiza la pantalla en cada tecla.
 *
 * El texto vive en estado local mientras se escribe y sube al borrador al salir
 * del campo. Sin esto, cada pulsación recorría el árbol entero de la revisión y
 * reprogramaba los dos temporizadores de autoguardado.
 *
 * No se pierde nada: al desmontarse el componente —salir de la sala, cerrar el
 * bloque— el efecto de limpieza confirma lo escrito.
 */
function TextoLargo({
  value,
  onCommit,
  placeholder,
  rows,
  className,
  label,
}: {
  value: string
  onCommit: (value: string) => void
  placeholder: string
  rows: number
  className: string
  label: string
}): React.ReactElement {
  const [local, setLocal] = useState(value)
  const pendiente = useRef(value)

  useEffect(() => {
    pendiente.current = local
  }, [local])

  // Confirmar al desmontar: cerrar el bloque o salir del aula no puede tirar lo
  // que el técnico acaba de escribir.
  useEffect(() => {
    return () => {
      if (pendiente.current !== value) onCommit(pendiente.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <label>
      <span className="sr-only">{label}</span>
      <textarea
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => local !== value && onCommit(local)}
        placeholder={placeholder}
        rows={rows}
        className={className}
      />
    </label>
  )
}

function NotaIncidencia({
  value,
  onCommit,
}: {
  value: string
  onCommit: (value: string) => void
}): React.ReactElement {
  return (
    <TextoLargo
      value={value}
      onCommit={onCommit}
      placeholder="¿Qué has visto?"
      rows={2}
      className="mt-2 w-full rounded-ctl border border-crit/25 bg-surface p-2 text-sm"
      label="Qué has visto"
    />
  )
}

export type { CheckKey }
