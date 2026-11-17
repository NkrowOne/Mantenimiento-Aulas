import { ExportarConVistaPrevia } from '@/features/inventory/ExportarConVistaPrevia'
import { exportacionDelHistorial, type AlcanceDelHistorial } from './exportarHistorial'

/**
 * El historial de una sala o de un edificio, para llevárselo: se ve, y se
 * descarga en Excel o en PDF.
 *
 * Es un fichero aparte para que la ficha y la lista de salas lo carguen **solo
 * cuando hace falta** (`lazy`). Detrás de la vista previa va el motor que
 * escribe el Excel, y la ficha del aula es la pantalla que más veces se abre al
 * día y casi siempre sin cobertura de sobra: meterle ese motor en el arranque
 * para una descarga que se pide una vez al mes sería cobrárselo a todos.
 */
export default function DescargarHistorial({
  alcance,
  titulo,
  descripcion,
}: {
  alcance: AlcanceDelHistorial
  titulo: string
  descripcion: string
}): React.ReactElement {
  return (
    <ExportarConVistaPrevia
      titulo={titulo}
      descripcion={descripcion}
      preparar={() => exportacionDelHistorial(alcance)}
    />
  )
}
