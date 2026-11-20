# Tarjetas

App web (PWA) para estudiar vocabulario de francés con repaso espaciado al estilo Anki (SM-2). Funciona sin conexión, se instala en la pantalla de inicio del iPhone y guarda todo en el dispositivo (IndexedDB). No tiene login ni backend.

**URL:** https://yuizz.github.io/anki/

## Instalar en el iPhone

1. Abre la URL en **Safari**.
2. Toca **Compartir** → **Agregar a inicio** → **Agregar**.
3. Abre la app desde el ícono. Desde ese momento funciona sin internet. En **Ajustes → Dispositivo** puedes ver si está "Lista para usarse sin conexión".

Para el audio necesitas una voz francesa: Ajustes del iPhone → Accesibilidad → Contenido leído → Voces → Francés.

## Formato del CSV

Va en UTF-8 (con o sin BOM), con saltos de línea CRLF o LF, y con separador coma, tab o punto y coma (se detecta solo). Los campos que tengan comas, comillas o saltos de línea van entre comillas dobles; una comilla dentro de un campo se escribe `""`. En **Ajustes → CSV** puedes descargar una plantilla.

| Columna | Obligatoria | Qué es |
| --- | --- | --- |
| `Frances` | sí | La palabra (frente). Identifica la palabra dentro del mazo. |
| `Espanol` | sí, para palabras nuevas | La traducción (reverso). |
| `Tipo` | no | verbo, sustantivo, artículo… |
| `Ejemplo`, `Ejemplo_ES`, `Uso` | no | Primer uso: frase en francés, su traducción y una etiqueta opcional (p. ej. *pronombre*). |
| `Ejemplo2`, `Ejemplo2_ES`, `Uso2`, `Ejemplo3`… | no | Más usos, sin límite. |
| `Notas` | no | Una nota libre (género, irregularidad…). |

En cada repaso se muestra **uno de los usos al azar**, distinto al de la vez anterior. Con el botón de flechas cruzadas pasas al siguiente.

```csv
Frances,Espanol,Tipo,Ejemplo,Ejemplo_ES,Uso,Ejemplo2,Ejemplo2_ES,Uso2,Notas
"le, la, les","el, la, los/las; lo, la, los",artículo / pronombre,Le chat dort sur la chaise.,El gato duerme en la silla.,artículo,Je la vois tous les jours.,La veo todos los días.,pronombre,Delante de vocal: l’
être,"ser, estar",verbo,Je suis ingénieur.,Soy ingeniero.,profesión,Nous sommes à Paris.,Estamos en París.,lugar,Irregular
```

**Compatibilidad:** el formato original `Frances,Espanol,Tipo,Ejemplo,Ejemplo_ES` sigue funcionando igual. Los encabezados no distinguen mayúsculas ni acentos (`Francés`, `Ejemplo 2 ES`…). Un archivo sin encabezado reconocido se lee como frente y reverso, y antes de importar puedes reasignar las columnas.

### Agregar o actualizar un mazo en bloque

Puedes importar un CSV en un mazo que ya existe, desde **Inicio → Importar CSV** o desde el mazo con **Importar o actualizar con CSV**:

- Las palabras nuevas se agregan.
- Las palabras que ya existen (mismo `Frances`) se **actualizan sin perder el progreso**. Una celda con texto reemplaza el valor anterior; una celda vacía no borra nada. Los usos nuevos se suman a los que ya tenía la palabra.
- Si prefieres no tocar las palabras existentes, elige **Dejarla como está**.

Antes de importar ves cuántas palabras son nuevas, cuántas se actualizarán y cuántas no cambian.

La forma más cómoda de editar un mazo grande: en el mazo, toca **Exportar mazo a CSV**, edítalo en Numbers o Excel y vuelve a importarlo. Para borrar palabras o usos, hazlo dentro de la app; el CSV nunca borra.

## Respaldo

Todo vive solo en tu teléfono. En **Ajustes → Respaldo**:

- **Exportar respaldo (JSON)** descarga mazos, palabras, progreso y ajustes. En el iPhone guárdalo en Archivos o iCloud Drive (o usa **Compartir respaldo…**).
- **Importar respaldo (JSON)** lo restaura, reemplazando todo o combinándolo con lo actual. También acepta respaldos de la versión 1.0.

La app te avisa si pasaron más de 14 días desde el último respaldo.

## Repaso espaciado

- Pasos de aprendizaje de 1 y 10 min. *Bien* en el último paso pasa la tarjeta a repaso a 1 día y *Fácil* a 4 días.
- En repaso, *Otra vez* resta 0,20 al ease y la manda a reaprendizaje (10 min) con el intervalo a la mitad (mínimo 1 día). *Difícil* multiplica el intervalo por 1,2 y resta 0,15 al ease. *Bien* lo multiplica por el ease, y *Fácil* por ease × 1,3 y suma 0,15 al ease. El ease empieza en 2,5 y no baja de 1,3.
- Los intervalos de más de 2 días llevan un fuzz de ±5 %. Además, cada botón da al menos un día más que el anterior.
- Por defecto son 10 nuevas y 200 repasos al día, y el día cambia a las 4:00 AM. Las nuevas pueden salir en orden o al azar (Ajustes → Orden de las nuevas).
- Atajos en computadora: espacio para mostrar la respuesta, 1–4 para responder, `e` para ver otro uso y `z` para deshacer.

## Desarrollo

Son archivos estáticos (HTML, CSS y ES modules), sin build ni dependencias. Para probar en local, sirve la carpeta con cualquier servidor estático, por ejemplo `python3 -m http.server`. Las pruebas corren así:

```bash
node --test
```

Cuando cambies archivos, sube `VERSION` en `app.js` y `sw.js` para que el service worker renueve el caché. Si agregas un archivo, súmalo también a `SHELL` en `sw.js` para que funcione sin conexión. Una prueba verifica que las dos versiones coincidan.
