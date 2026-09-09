/**
 * EL CONTRATO: qué es este servicio y, sobre todo, qué no es.
 *
 * Es la síntesis del pliego «Servicio integral de Soporte en Aulas» de la
 * Universidad Francisco de Vitoria, y está aquí por un motivo concreto: la IA
 * que redacta el informe se tomaba libertades. Sin saber dónde acaba el
 * encargo, un modelo al que se le pide «di qué conviene hacer» acaba
 * recomendando implantar una herramienta de tickets —que ya existe y la pone la
 * universidad—, renegociar los acuerdos de nivel de servicio, contratar a más
 * gente, comprar equipamiento o revisar el cableado del edificio. Nada de eso
 * lo decide este servicio, y un informe que lo propone deja de ser un informe
 * del trabajo hecho para convertirse en una lista de deberes ajenos que el
 * cliente lee como si fueran nuestros.
 *
 * Lo que va aquí es solo lo que cambia lo que el informe puede decir. El pliego
 * entero —la propuesta económica, los CV, el plan de devolución, los hitos de
 * facturación— no pinta nada en un informe semanal y por eso no está.
 *
 * **Esto no es una fuente de cifras.** Ni una sola de estas líneas se cuenta en
 * ningún indicador: los números del informe salen de la base de datos, siempre.
 * Esto acota lo que se puede *recomendar* y con qué vara se mide lo que se hizo.
 */

/** Los espacios del contrato, tal y como los desglosa el pliego. */
export const ESPACIOS = [
  { que: 'Aulas', cuantos: 368 },
  { que: 'Salas de reuniones', cuantos: 66 },
  { que: 'Espacios DOT (aulas multimedia y de reuniones)', cuantos: 13 },
  { que: 'Laboratorios', cuantos: 10 },
  { que: 'Work Café Santander', cuantos: 1 },
  { que: 'MSI (Alcorcón): revisión quincenal in situ y soporte remoto', cuantos: 17 },
  { que: 'Despachos de directores generales', cuantos: 4 },
  { que: 'Clínica dental (Madrid): revisión mensual in situ y soporte remoto', cuantos: 7 },
] as const

/**
 * Los tiempos comprometidos, por criticidad.
 *
 * El tiempo de respuesta es el que va desde que entra la solicitud hasta que se
 * asigna a un técnico; el de resolución, desde esa asignación hasta el cierre.
 * `cumplimiento` es el porcentaje de casos del mes que tienen que caer dentro:
 * el compromiso no es «siempre», es ese porcentaje, y confundirlo es la forma
 * más fácil de dar por incumplido un mes que fue bien. Los porcentajes son los
 * del primer año, que es el que está en vigor.
 */
export const NIVELES = [
  {
    criticidad: 'Crítica',
    definicion: 'Impide impartir una clase. También la atención a usuarios VIP.',
    respuesta: '5 minutos',
    resolucion: '10 minutos',
    cumplimiento: '96 %',
  },
  {
    criticidad: 'Alta',
    definicion: 'Afecta mucho a la operación, pero se resuelve en el siguiente bloque horario.',
    respuesta: '5 minutos',
    resolucion: '2 horas',
    cumplimiento: '93 %',
  },
  {
    criticidad: 'Media',
    definicion: 'Afecta a la operación y se puede manejar a lo largo del día.',
    respuesta: '5 minutos',
    resolucion: '8 horas',
    cumplimiento: '93 %',
  },
  {
    criticidad: 'Baja',
    definicion:
      'Revisiones de aulas o salas, y cambios de dispositivo que dependen del stock o de que el aula esté libre.',
    respuesta: '5 minutos',
    resolucion: '26 horas',
    cumplimiento: '92 %',
  },
] as const

/**
 * El marco del servicio, en el idioma en que lo va a leer el modelo.
 *
 * Va en la instrucción del sistema y no en el expediente de datos, y la
 * diferencia importa: el expediente son los hechos de este periodo —cambian
 * cada semana— y esto es la regla del documento, que no cambia. Puesto en el
 * expediente, el modelo lo trataría como un dato más del que sacar cifras.
 */
export const MARCO_DEL_SERVICIO = `EL SERVICIO DEL QUE HABLA ESTE INFORME

Soporte en aulas de la Universidad Francisco de Vitoria, prestado de forma
presencial por una empresa externa. El encargo es mantener en marcha el
equipamiento audiovisual e informático de los espacios docentes y de reunión, y
atender lo que pase en ellos mientras hay clase.

Qué entra en el encargo:
- Atender incidencias y peticiones de los espacios: aulas, laboratorios, salas de reuniones y espacios DOT.
- Instalar y configurar los equipos del aula, y plataformar y actualizar los que lo necesiten.
- Mantenimiento y puesta a punto de aulas y laboratorios antes del comienzo de curso, de Navidad y de Semana Santa.
- Sustituir equipos y piezas averiadas, gestionando con el fabricante o el proveedor la reparación o el reemplazo.
- Mantener el inventario de los equipos de las aulas —hardware al día cada semana, y el software instalado señalando el que no esté homologado.
- Formar y orientar a quien usa el aula, y proponer mejoras.
- Horario de lunes a viernes de 7:00 a 21:00, presencial. Fines de semana solo en eventos puntuales.

Qué NO es este servicio, y por tanto nunca se recomienda en este informe:
- No decide compras ni inversiones: se puede decir que hace falta reponer algo o sustituir un equipo, y quien lo aprueba es la universidad.
- No elige ni implanta herramientas: la de tickets la pone la universidad y ya está en uso.
- No define ni renegocia los niveles de servicio, ni los plazos, ni las penalizaciones.
- No decide la plantilla: cuánta gente hay en el servicio no es materia de un informe de periodo.
- No lleva la red, los servidores, la wifi, las cuentas de usuario ni las plataformas académicas. Lo muy especializado se escala al equipo interno de la universidad.
- No hace obra, ni electricidad, ni mobiliario, ni el mantenimiento del edificio.
- No habla de otros contratos ni de otros lotes del pliego.

Cómo se mide lo que se hizo (compromiso del primer año, sobre el porcentaje de casos de cada mes):
- Crítica —impide dar clase, o es un usuario VIP—: se atiende en 5 minutos y se resuelve en 10, en el 96 % de los casos.
- Alta: 5 minutos para atender, 2 horas para resolver, en el 93 %.
- Media: 5 minutos para atender, 8 horas para resolver, en el 93 %.
- Baja —revisiones de aulas, y cambios que dependen del stock o de que el aula esté libre—: 5 minutos para atender, 26 horas para resolver, en el 92 %.
- Satisfacción del usuario por encima del 95 %.

Cómo se escribe con esto delante:
- Las recomendaciones son cosas que este servicio puede hacer la semana que viene, o decisiones que la universidad tiene que tomar y que el informe le pone delante con su dato. Nada más.
- Un plazo solo se cita si el expediente trae la cifra. El compromiso es un porcentaje de casos al mes, no un «siempre»: no se declara incumplido un mes que el expediente no dice que lo esté.
- No se propone cambiar el alcance, la herramienta, el contrato ni el equipo.`

/**
 * Lo que se propone y no toca a este servicio.
 *
 * La instrucción reduce el problema y no lo cierra: un modelo con muchos datos
 * y poco que recomendar tira de lo que ha visto en otros informes, y lo que ha
 * visto en otros informes es «implantar una herramienta de ticketing»,
 * «renegociar el SLA» o «reforzar la plantilla». Así que se comprueba la
 * salida, igual que se comprueban las cifras inventadas y las fórmulas de
 * relleno.
 *
 * Cada entrada es lo que NO se decide aquí y la palabra que lo delata. Están
 * escritas para no morder lo que sí se puede decir: «hay que reponer lámparas»
 * es del servicio y no lleva ninguna de estas; «ampliar el contrato», sí.
 */
const FUERA_DE_ALCANCE: Array<{ que: string; patron: RegExp }> = [
  {
    que: 'el contrato y sus plazos',
    patron: /\b(renegociar|renegociaci[oó]n|revisar el (contrato|pliego|acuerdo de nivel)|ampliar el contrato|modificar (el|los) (contrato|sla|ans)|penalizaci[oó]n(es)? contractual)/i,
  },
  {
    que: 'la plantilla del servicio',
    patron: /\b(ampliar|reforzar|aumentar|redimensionar|incrementar) (la )?(plantilla|el equipo|los? (fte|efectivos|recursos humanos))|contratar (a )?(m[aá]s|otro|un) (t[eé]cnico|personal|gente)/i,
  },
  {
    que: 'las herramientas, que las pone la universidad',
    patron: /\b(implantar|implementar|desplegar|adquirir|migrar a|cambiar de) (una |un |la |el )?(herramienta|plataforma|software|sistema) de (ticket|gesti[oó]n de incidencias|itsm|cmdb)|\b(implantar|implementar) (un|el) (crm|erp|itsm)/i,
  },
  {
    que: 'la red, los servidores y las plataformas académicas',
    patron: /\b(la red del campus|infraestructura de red|los servidores|el servidor de|la wifi|moodle|el campus virtual|el directorio activo|active directory|las cuentas de usuario)\b/i,
  },
  {
    que: 'la obra y el mantenimiento del edificio',
    patron: /\b(obra civil|reforma del (aula|edificio)|instalaci[oó]n el[eé]ctrica|climatizaci[oó]n|mobiliario|carpinter[ií]a|falso techo)\b/i,
  },
  {
    que: 'la formación reglada y la política de la universidad',
    patron: /\b(plan de formaci[oó]n (del profesorado|docente)|pol[ií]tica (de seguridad|inform[aá]tica) de la universidad|normativa acad[eé]mica)\b/i,
  },
]

/**
 * Lo que un texto propone y que este servicio no decide. Vacío si va limpio.
 *
 * Devuelve el motivo y el trozo que lo delata, para poder decirlo en el
 * registro: «esto se descartó porque proponía renegociar el contrato» se
 * entiende, y «la IA falló» no.
 */
export function fueraDeAlcance(texto: string): Array<{ que: string; dice: string }> {
  const out: Array<{ que: string; dice: string }> = []
  for (const { que, patron } of FUERA_DE_ALCANCE) {
    const m = patron.exec(texto)
    if (m) out.push({ que, dice: m[0] })
  }
  return out
}
