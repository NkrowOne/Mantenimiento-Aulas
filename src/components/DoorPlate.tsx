/**
 * La placa de puerta, con su QR.
 *
 * Es el mismo objeto que la cabecera de la revisión imita —ubicación arriba,
 * nombre grande, matrícula a un lado, dos tornillos— pero aquí completo y con el
 * código escaneable, porque esta versión es la que se imprime y se atornilla.
 *
 * Las tres cosas que muestra dicen cosas distintas a propósito:
 *
 *   nombre     Cambia. Es una etiqueta y se puede editar cuando haga falta.
 *   matrícula  No cambia nunca. Es lo que se dicta por teléfono.
 *   QR         Codifica el identificador interno, que tampoco cambia. Escanear
 *              lleva a la sala correcta aunque el nombre de la placa esté viejo.
 */

import { QR } from './QR'
import { enlaceDeSala } from '@/lib/enlace-sala'

interface Props {
  building: string
  zone: string
  title: string
  /** `SALA-000087`. La referencia corta y estable. */
  ref: string
  /** El UUID de la sala: lo que codifica el QR. */
  id: string
  /** Más pequeña, para la hoja de impresión. */
  compacta?: boolean
}

export function DoorPlate({
  building,
  zone,
  title,
  ref: matricula,
  id,
  compacta = false,
}: Props): React.ReactElement {
  return (
    <div className="plate relative flex items-stretch overflow-hidden rounded-card border border-line bg-surface">
      {/* Los dos tornillos. Detalle pequeño, y es lo que convierte un rectángulo
          en una placa: sin ellos esto es una tarjeta más. */}
      <span
        aria-hidden
        className="absolute left-[7px] top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full bg-sunken shadow-[inset_0_1px_1px_rgba(0,0,0,.35)]"
      />

      <div className={`min-w-0 flex-1 border-r border-line ${compacta ? 'px-4 py-2.5' : 'px-5 py-4'}`}>
        <p className="font-mono text-[0.625rem] font-bold uppercase tracking-[0.17em] text-muted">
          {building} · {zone}
        </p>
        <h3
          className={`mt-1 truncate font-bold leading-[1.2] tracking-tight ${
            compacta ? 'text-lg' : 'text-[1.6rem]'
          }`}
        >
          {title}
        </h3>
        {/* El identificador, recortado por el medio.
            No está para leerlo entero —para eso no sirve un UUID— sino para
            poder cotejar dos placas a ojo si alguna vez se duplica una etiqueta.
            Entero ocupaba más que el propio nombre de la sala y competía con él;
            las dos puntas bastan para distinguirlos y no roban jerarquía. */}
        <p className="mt-0.5 truncate font-mono text-[0.625rem] text-muted">
          {id.slice(0, 8)}…{id.slice(-4)}
        </p>
      </div>

      <div
        className={`flex shrink-0 flex-col items-center justify-center gap-1.5 ${
          compacta ? 'px-3 py-2.5' : 'px-5 py-4'
        }`}
      >
        {/* Fondo blanco y sólido bajo el QR también en modo oscuro: el escáner
            lee contraste, y un código sobre superficie oscura no se lee. */}
        <span className="rounded-[3px] bg-white p-1">
          {/* Se codifica un ENLACE, no el identificador pelado. Con el UUID a
              secas, la cámara del móvil enseña una cadena hexadecimal y no
              ofrece nada que pulsar: correcto y completamente inútil delante de la puerta.
              Con el enlace, la cámara lo reconoce, la PWA lo recoge y salta al
              aula. El identificador sigue siendo lo que viaja dentro. */}
          <QR
            value={enlaceDeSala(id)}
            size={compacta ? 52 : 72}
            label={`Abrir la sala ${title} escaneando este código`}
          />
        </span>
        <span className="font-mono text-[0.5625rem] font-semibold tracking-[0.08em] text-ink">
          {matricula}
        </span>
      </div>

      <span
        aria-hidden
        className="absolute right-[7px] top-1/2 h-[5px] w-[5px] -translate-y-1/2 rounded-full bg-sunken shadow-[inset_0_1px_1px_rgba(0,0,0,.35)]"
      />
    </div>
  )
}
