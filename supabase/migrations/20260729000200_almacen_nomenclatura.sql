-- =============================================================================
-- Almacén: letras normalizadas, nomenclatura unificada, sin redundancias
--
-- La lista de artículos venía de dos sitios que no se hablaban. La hoja
-- *Bolsa 2026* aportó los 43 artículos que de verdad se compran y se cuentan.
-- El campo «Material Usado» del histórico de incidencias —texto libre escrito
-- con prisa desde un aula— aportó otros setenta y tantos, que no son artículos
-- nuevos sino los mismos mal escritos: «Cable Hdmi 10mts Fibra», «cable hdmi
-- Fibra 10mts» y «cables Hdmi 10mts Fibra» son un cable, no tres.
--
-- Así quedaba la pantalla de Almacén: «Matriz HDMI» y «Matriz Hdmi» separadas
-- por una fila, dos mandos a distancia que son el mismo mando, y «metros»,
-- «pulgadas» o «EEB» ocupando sitio como si fueran material. Con la lista así,
-- buscar no encuentra, contar no cuadra, y el informe de consumo reparte el
-- gasto de un solo cable entre seis grafías distintas.
--
-- Esta migración hace tres cosas y no toca ningún saldo:
--
--  1. **Funde** cada grupo de grafías en un artículo. Los movimientos y las
--     incidencias del absorbido pasan al superviviente, así que las existencias
--     de después son exactamente la suma de las de antes y el histórico sigue
--     enlazado. El artículo redundante desaparece de la lista, no de la vida:
--     cada fusión queda anotada en `import_fixes` con el nombre original.
--  2. **Renombra** al canónico: siglas en mayúscula (HDMI, USB, RS-232,
--     DisplayPort), longitudes en metros con la unidad separada (`10 m`, nunca
--     `10mts` ni `10 metros`) y el resto en minúscula salvo marcas y modelos.
--  3. **Archiva** lo que no llega a ser un artículo. «mts» no es medio cable de
--     fibra: repartirlo entre los cables sería inventarse el inventario. Se
--     marca `active = false`, que lo saca de la pantalla de Almacén sin romper
--     el enlace con la incidencia que lo cita.
--
-- Y al final pone la cerradura que faltaba: un índice único sobre el nombre
-- normalizado, el mismo que ya protege `asset_types`. Sin él nada impide que
-- mañana vuelvan a convivir «Teclado» y «teclado», que es como se llegó hasta
-- aquí. Este índice es la mitad que perdura; lo de arriba es limpiar una vez.
--
-- La tabla de nombres es gemela de `src/domain/almacen.ts`, que es la que usa
-- el importador para que una instalación nueva nazca ya limpia. Un test compara
-- las dos: si alguien toca una y no la otra, salta.
--
-- Volver a ejecutarla no hace nada: cada canónico se mapea a sí mismo.
-- =============================================================================

drop table if exists tmp_almacen_map;
drop table if exists tmp_almacen_fragmento;

-- Nombre escrito alguna vez → nombre bueno. El canónico se mapea a sí mismo a
-- propósito: es lo que hace la corrección repetible.
create table tmp_almacen_map (variante text primary key, canonico text not null);

insert into tmp_almacen_map (variante, canonico) values
  ('Cable HDMI 3 m', 'Cable HDMI 3 m'),
  ('Cable HDMI 3 mts', 'Cable HDMI 3 m'),
  ('Cable Hdmi 3mts', 'Cable HDMI 3 m'),
  ('cables Hdmi 3mts', 'Cable HDMI 3 m'),
  ('Cable HDMI 5 m', 'Cable HDMI 5 m'),
  ('Cable Hdmi 5 metros', 'Cable HDMI 5 m'),
  ('Cable HDMI 5mts', 'Cable HDMI 5 m'),
  ('Cable HDMI 7,5 m', 'Cable HDMI 7,5 m'),
  ('Cable HDMI 7,5 mts', 'Cable HDMI 7,5 m'),
  ('Cable Hdmi 7mts', 'Cable HDMI 7,5 m'),
  ('Cable Hdmi de 7mts', 'Cable HDMI 7,5 m'),
  ('Cable HDMI fibra 10 m', 'Cable HDMI fibra 10 m'),
  ('Cable HDMI Fibra 10 mts', 'Cable HDMI fibra 10 m'),
  ('Cable Hdmi 10mts Fibra', 'Cable HDMI fibra 10 m'),
  ('cables Hdmi 10mts Fibra', 'Cable HDMI fibra 10 m'),
  ('Cable hdmi Fibra 10mts', 'Cable HDMI fibra 10 m'),
  ('cables hdmi fibra 10mts', 'Cable HDMI fibra 10 m'),
  ('Cable HDMI 10mts', 'Cable HDMI fibra 10 m'),
  ('Cables Hdmi 10mts', 'Cable HDMI fibra 10 m'),
  ('cable 10mts fibra', 'Cable HDMI fibra 10 m'),
  ('Cable HDMI fibra 15 m', 'Cable HDMI fibra 15 m'),
  ('Cable HDMI Fibra 15 mts', 'Cable HDMI fibra 15 m'),
  ('Cable Hdmi 15mts Fibra', 'Cable HDMI fibra 15 m'),
  ('Cables Hdmi 15mts Fibra', 'Cable HDMI fibra 15 m'),
  ('cables Hdmi15mts Fibra', 'Cable HDMI fibra 15 m'),
  ('cable Hdmi fibra 15mts', 'Cable HDMI fibra 15 m'),
  ('cable Hdmi fibra15mts', 'Cable HDMI fibra 15 m'),
  ('cables hdmi fibra 15mts', 'Cable HDMI fibra 15 m'),
  ('cables 15mts Fibra', 'Cable HDMI fibra 15 m'),
  ('Cable HDMI fibra 20 m', 'Cable HDMI fibra 20 m'),
  ('Cable HDMI Fibra 20 mts', 'Cable HDMI fibra 20 m'),
  ('Cable hdmi 20mts Fibra', 'Cable HDMI fibra 20 m'),
  ('cables Hdmi 20mts Fibra', 'Cable HDMI fibra 20 m'),
  ('Cable USB 10 m', 'Cable USB 10 m'),
  ('Cable USB 10 mts', 'Cable USB 10 m'),
  ('Cable USB 10mts', 'Cable USB 10 m'),
  ('Cable USB 15 m', 'Cable USB 15 m'),
  ('Cable USB 15 mts', 'Cable USB 15 m'),
  ('Cable usb 15mts', 'Cable USB 15 m'),
  ('Cable audio minijack 10 m', 'Cable audio minijack 10 m'),
  ('Cable Audio Mini Jack 10mts', 'Cable audio minijack 10 m'),
  ('cable mini jack', 'Cable audio minijack 10 m'),
  ('Cable RS-232', 'Cable RS-232'),
  ('Cable RS 232', 'Cable RS-232'),
  ('Conversor USB a HDMI', 'Conversor USB a HDMI'),
  ('Converso USB a  HDMI', 'Conversor USB a HDMI'),
  ('conversores Usb a Hdmi', 'Conversor USB a HDMI'),
  ('conversor de Usb a Hdmi', 'Conversor USB a HDMI'),
  ('conversores de USB a HDMI', 'Conversor USB a HDMI'),
  ('adaptador USB a HDMI', 'Conversor USB a HDMI'),
  ('Adaptador usb HDMI', 'Conversor USB a HDMI'),
  ('Conversor DisplayPort a HDMI', 'Conversor DisplayPort a HDMI'),
  ('Converos DP a HDMI', 'Conversor DisplayPort a HDMI'),
  ('covserso DP a Hdmi', 'Conversor DisplayPort a HDMI'),
  ('Adaptador DisplayPort a HDMI', 'Conversor DisplayPort a HDMI'),
  ('Adaptador Dp a HDMI', 'Conversor DisplayPort a HDMI'),
  ('Adaptador Dp -Hdmi', 'Conversor DisplayPort a HDMI'),
  ('adaptador hdmi a displayport', 'Conversor DisplayPort a HDMI'),
  ('Dp a HDMI', 'Conversor DisplayPort a HDMI'),
  ('Adaptador HDMI hembra-hembra', 'Adaptador HDMI hembra-hembra'),
  ('Adaptador HDMI F to F', 'Adaptador HDMI hembra-hembra'),
  ('Matriz HDMI', 'Matriz HDMI'),
  ('Hub HDMI 1 entrada / 4 salidas', 'Hub HDMI 1 entrada / 4 salidas'),
  ('Hub de Hdmi 1In / 4 Out', 'Hub HDMI 1 entrada / 4 salidas'),
  ('Hub USB', 'Hub USB'),
  ('Hub de USB', 'Hub USB'),
  ('Selector automático HDMI 1 entrada / 2 salidas', 'Selector automático HDMI 1 entrada / 2 salidas'),
  ('Selector automatico Hdmi 1In / 2 Out', 'Selector automático HDMI 1 entrada / 2 salidas'),
  ('selector automatico', 'Selector automático HDMI 1 entrada / 2 salidas'),
  ('selector automatico,', 'Selector automático HDMI 1 entrada / 2 salidas'),
  ('Extensor USB 2.0 AE', 'Extensor USB 2.0 AE'),
  ('Extensor USB 3.0 AE', 'Extensor USB 3.0 AE'),
  ('Proyector Epson', 'Proyector Epson'),
  ('Proyector Epson (Ed. Antonio Gaudí)', 'Proyector Epson (Ed. Antonio Gaudí)'),
  ('Soporte de techo para proyector', 'Soporte de techo para proyector'),
  ('Lámpara proyector NP30', 'Lámpara proyector NP30'),
  ('Lámpara proyector NP44', 'Lámpara proyector NP44'),
  ('Lámpara proyector NP47', 'Lámpara proyector NP47'),
  ('Lámpara proyector 0I-ET-LAV400', 'Lámpara proyector 0I-ET-LAV400'),
  ('Pantalla de proyección 2,30 x 2,30 m', 'Pantalla de proyección 2,30 x 2,30 m'),
  ('Pantalla proyección  de 2,30 mts x 2,30 mts', 'Pantalla de proyección 2,30 x 2,30 m'),
  ('Pantalla de proyección 2,40 x 2,40 m', 'Pantalla de proyección 2,40 x 2,40 m'),
  ('Pantalla proyección  de 2,40 mts x 2,40 mts', 'Pantalla de proyección 2,40 x 2,40 m'),
  ('Pantalla de proyección 3,00 m', 'Pantalla de proyección 3,00 m'),
  ('Pantalla de proyección de 3,00mts', 'Pantalla de proyección 3,00 m'),
  ('Mando a distancia de pantalla de proyección', 'Mando a distancia de pantalla de proyección'),
  ('mando a distancia para pantalla de proyección', 'Mando a distancia de pantalla de proyección'),
  ('mando a distancia pantalla proyección', 'Mando a distancia de pantalla de proyección'),
  ('Monitor 86" (edificio BC)', 'Monitor 86" (edificio BC)'),
  ('Monitor 86 " (edificio BC)', 'Monitor 86" (edificio BC)'),
  ('Monitor NEC 49"', 'Monitor NEC 49"'),
  ('Monitor táctil iiyama T2454MSC 24,5"', 'Monitor táctil iiyama T2454MSC 24,5"'),
  ('Monitor táctil iiyama 24,5" T2454MSC', 'Monitor táctil iiyama T2454MSC 24,5"'),
  ('Altavoces', 'Altavoces'),
  ('Juego de altavoces', 'Altavoces'),
  ('Juego de altavoces,', 'Altavoces'),
  ('Micrófono Jabra con soporte de mesa', 'Micrófono Jabra con soporte de mesa'),
  ('Jabra Panacast 50', 'Jabra Panacast 50'),
  ('Cámara Aver', 'Cámara Aver'),
  ('Camaras Aver', 'Cámara Aver'),
  ('Camara', 'Cámara Aver'),
  ('Botonera', 'Botonera'),
  ('Ordenador Tiny M70Q', 'Ordenador Tiny M70Q'),
  ('Ordenador Tiny M710Q', 'Ordenador Tiny M710Q'),
  ('Ordenador Tiny M720Q', 'Ordenador Tiny M720Q'),
  ('Ordenador Tiny Neo 50Q', 'Ordenador Tiny Neo 50Q'),
  ('Teclado', 'Teclado'),
  ('teclados de pc', 'Teclado'),
  ('Teclado nuevo', 'Teclado'),
  ('Ratón', 'Ratón'),
  ('Regleta de luz', 'Regleta de luz');

-- Restos de partir el texto libre: la unidad suelta, la frase cortada, o un
-- material real del que no se dice cuál de las variantes era.
create table tmp_almacen_fragmento (nombre text primary key);

insert into tmp_almacen_fragmento (nombre) values
  ('mts'),
  ('metros'),
  ('pulgadas'),
  ('EEB'),
  ('cables de'),
  ('Cable de'),
  ('cable HDMI 1.8 m y'),
  ('cables Hdmi'),
  ('cable Hdmi'),
  ('cable Hmdi'),
  ('cable Hdmi fibra'),
  ('cables Hdmi fibra'),
  ('cable usb'),
  ('Cables Usb'),
  ('cable Usb camara'),
  ('cable extender usb'),
  ('m fibra'),
  ('mts Fibra'),
  ('mts de fibra'),
  ('mts de fibra monitor tactil'),
  ('mts canaleta de suelo'),
  ('metros red'),
  ('monitor Tiny');

do $$
declare
  r        record;
  v_keeper uuid;
  v_actual text;
begin
  -- ---------------------------------------------------------------------------
  -- 1 y 2 — Fusionar cada grupo de grafías y dejar el nombre canónico
  -- ---------------------------------------------------------------------------
  for r in
    select m.canonico, array_agg(si.id) as ids
      from tmp_almacen_map m
      join stock_items si on public.norm_text(si.name) = public.norm_text(m.variante)
     group by m.canonico
  loop
    -- Quién sobrevive. El que ya se llama como toca va primero —renombrarlo es
    -- gratis y conserva su id, que es lo que tienen guardado los clientes—; si
    -- ninguno, el que lleva el movimiento de saldo inicial, que es el artículo
    -- de verdad frente a la mención suelta del histórico.
    select si.id into v_keeper
      from stock_items si
     where si.id = any(r.ids)
     order by (public.norm_text(si.name) = public.norm_text(r.canonico)) desc,
              (select count(*) from stock_movements sm where sm.stock_item_id = si.id) desc,
              si.name
     limit 1;

    if array_length(r.ids, 1) > 1 then
      insert into import_fixes (source, row_ref, field, original, corrected, reason)
      select 'Almacén', si.name, 'stock_items.name', si.name, r.canonico,
             'Artículo redundante: se funde con el canónico y se le traspasan movimientos e incidencias'
        from stock_items si
       where si.id = any(r.ids) and si.id <> v_keeper;

      update stock_movements   set stock_item_id = v_keeper
       where stock_item_id = any(r.ids) and stock_item_id <> v_keeper;
      update incident_materials set stock_item_id = v_keeper
       where stock_item_id = any(r.ids) and stock_item_id <> v_keeper;

      -- Lo que el superviviente no tenga configurado y el absorbido sí, se
      -- hereda: si el mínimo de aviso estaba puesto en la fila que desaparece,
      -- perderlo apagaría en silencio una alerta que alguien pidió.
      update stock_items k
         set asset_type_id = coalesce(k.asset_type_id, (
               select o.asset_type_id from stock_items o
                where o.id = any(r.ids) and o.id <> k.id and o.asset_type_id is not null
                order by o.name limit 1)),
             min_threshold = greatest(k.min_threshold, coalesce((
               select max(o.min_threshold) from stock_items o
                where o.id = any(r.ids) and o.id <> k.id), 0))
       where k.id = v_keeper;

      delete from stock_items where id = any(r.ids) and id <> v_keeper;
    end if;

    select name into v_actual from stock_items where id = v_keeper;
    if v_actual is distinct from r.canonico then
      insert into import_fixes (source, row_ref, field, original, corrected, reason)
      values ('Almacén', v_actual, 'stock_items.name', v_actual, r.canonico,
              'Nomenclatura unificada: siglas en mayúscula, longitudes en metros');
      update stock_items set name = r.canonico where id = v_keeper;
    end if;

    -- Un artículo del catálogo está en la lista. Si estaba archivado —porque
    -- una pasada anterior lo tomó por un resto de texto— vuelve.
    update stock_items set active = true where id = v_keeper and not active;
  end loop;

  -- ---------------------------------------------------------------------------
  -- 3 — Archivar lo que no es un artículo
  -- ---------------------------------------------------------------------------
  for r in
    select si.id, si.name,
           (select count(*) from stock_movements sm where sm.stock_item_id = si.id) as movs
      from stock_items si
      join tmp_almacen_fragmento f on public.norm_text(si.name) = public.norm_text(f.nombre)
     where si.active
  loop
    -- Con movimientos ya no es un resto de texto: alguien ha estado contando
    -- unidades ahí. Archivarlo escondería un saldo real, así que se deja y se
    -- avisa para que lo resuelva una persona.
    if r.movs > 0 then
      insert into import_fixes (source, row_ref, field, original, corrected, reason)
      values ('Almacén', r.name, 'stock_items.active', 'true', 'true',
              'Nombre incompleto pero con movimientos registrados: renombrar a mano antes de archivar');
    else
      insert into import_fixes (source, row_ref, field, original, corrected, reason)
      values ('Almacén', r.name, 'stock_items.active', 'true', 'false',
              'No identifica un artículo: se archiva. Sigue enlazado a las incidencias que lo citan');
      update stock_items set active = false where id = r.id;
    end if;
  end loop;

  -- ---------------------------------------------------------------------------
  -- 4 — Barrido final: cualquier par que solo se diferencie en tildes o
  --     mayúsculas, esté o no en la tabla de arriba. Es lo que deja el terreno
  --     limpio para el índice único, y lo que recoge lo que se haya dado de
  --     alta desde la app entre medias.
  -- ---------------------------------------------------------------------------
  for r in
    select public.norm_text(name) as clave, array_agg(id) as ids
      from stock_items
     group by public.norm_text(name)
    having count(*) > 1
  loop
    select si.id into v_keeper
      from stock_items si
     where si.id = any(r.ids)
     order by si.active desc,
              (select count(*) from stock_movements sm where sm.stock_item_id = si.id) desc,
              si.name
     limit 1;

    select name into v_actual from stock_items where id = v_keeper;

    insert into import_fixes (source, row_ref, field, original, corrected, reason)
    select 'Almacén', si.name, 'stock_items.name', si.name, v_actual,
           'Mismo nombre con otras tildes o mayúsculas: se funde'
      from stock_items si
     where si.id = any(r.ids) and si.id <> v_keeper;

    update stock_movements   set stock_item_id = v_keeper
     where stock_item_id = any(r.ids) and stock_item_id <> v_keeper;
    update incident_materials set stock_item_id = v_keeper
     where stock_item_id = any(r.ids) and stock_item_id <> v_keeper;
    delete from stock_items where id = any(r.ids) and id <> v_keeper;
  end loop;
end $$;

drop table tmp_almacen_map;
drop table tmp_almacen_fragmento;

-- La cerradura. Va sobre el nombre normalizado y no sobre el nombre a secas
-- —que ya era único— porque el problema nunca fue «Teclado» dos veces, sino
-- «Teclado» y «teclado» conviviendo como dos artículos distintos.
create unique index if not exists stock_items_norm_idx
  on stock_items (public.norm_text(name));

comment on index stock_items_norm_idx is
  'Impide que vuelvan a convivir dos grafías del mismo artículo.';
