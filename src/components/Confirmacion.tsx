import { Icono } from '@/components/Icono'
import { useSinConexion } from '@/lib/conexion'

/**
 * «Hecho», dicho bien: qué ha pasado y, solo si hace falta, dónde está.
 *
 * Los avisos de la ficha decían «Incidencia registrada. Sube en cuanto haya
 * cobertura.» y «Resuelta. Sube en cuanto haya cobertura y queda en el historial
 * de la sala.». Dos problemas, y los dos los vio quien lo usa:
 *
 *  - **No se entendía.** «Sube» no tiene sujeto, y la frase entera es jerga de
 *    quien escribió la cola de salida. Era, además, texto verde suelto en mitad
 *    de la pantalla, sin nada que dijera que era una confirmación.
 *  - **Era mentira casi siempre.** Con conexión —el caso corriente— lo guardado
 *    se envía en el acto. Prometer que «subirá cuando haya cobertura» a quien
 *    tiene cuatro rayas de wifi le hace pensar que algo va mal.
 *
 * Ahora el aviso dice lo que se ha hecho y nada más. Y solo si de verdad no hay
 * conexión añade que está guardado en el dispositivo y que se enviará solo. Esa
 * segunda frase se mira en vivo: aparece si la conexión se cae y se quita
 * cuando vuelve.
 *
 * Esa frase es solo para lo que se guarda primero en el dispositivo —una
 * incidencia, un cierre, una revisión— y por eso hay que pedirla con `enCola`.
 * Lo que se hace contra el servidor (el almacén, el maestro) o ha ocurrido o ha
 * fallado: ahí no hay nada «pendiente de enviar» que contar.
 *
 * Y es la misma caja en toda la aplicación. Había una docena de confirmaciones,
 * cada una con su forma: texto verde suelto, caja teñida, con margen arriba,
 * con margen abajo. Ninguna estaba mal sola.
 *
 * `role="status"`: es la respuesta a un botón, y quien usa VoiceOver tiene que
 * oírla sin ir a buscarla.
 */
export function Confirmacion({
  texto,
  enCola = false,
  className = '',
}: {
  texto: React.ReactNode
  /** Se guardó en el dispositivo y se envía después: sin conexión, se dice. */
  enCola?: boolean
  className?: string
}): React.ReactElement {
  const sinConexion = useSinConexion() && enCola

  return (
    <div
      role="status"
      className={`confirmacion flex items-start gap-2.5 rounded-ctl bg-ok-tint px-3 py-2.5 text-sm ${className}`}
    >
      <Icono nombre="hecho" lado={18} className="mt-0.5 shrink-0 text-ok" />
      <p className="min-w-0 flex-1 leading-snug">
        <span className="font-medium text-ok">{texto}</span>
        {sinConexion && (
          <span className="mt-0.5 block text-ink-2">
            Sin conexión: está guardado en este dispositivo y se enviará automáticamente al
            recuperarla.
          </span>
        )}
      </p>
    </div>
  )
}
