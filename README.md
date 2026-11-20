# Tarjetas

App web (PWA) para estudiar vocabulario de francés con repaso espaciado al estilo Anki (SM-2). Funciona sin conexión, se instala en la pantalla de inicio del iPhone y guarda todo en el dispositivo (IndexedDB). No tiene login ni backend.

**URL:** https://yuizz.github.io/anki/

## Instalar en el iPhone

1. Abre la URL en **Safari**.
2. Toca **Compartir** (el cuadro con la flecha) → **Agregar a inicio** → **Agregar**.
3. Abre la app desde el ícono. Desde ese momento funciona sin internet.

Para el audio necesitas una voz francesa: Ajustes → Accesibilidad → Contenido leído → Voces → Francés.

## Formato del CSV

Importa desde la app Archivos con **Importar CSV**. Puede ir en UTF-8 (con o sin BOM), con saltos de línea CRLF o LF, y con separador coma, tab o punto y coma (se detecta solo). Los campos que tengan comas, comillas o saltos de línea van entre comillas dobles; una comilla dentro de un campo se escribe `""`.

Formato principal, con encabezado:

```csv
Frances,Espanol,Tipo,Ejemplo,Ejemplo_ES
"le, la, les","el, la, los/las (artículo); lo, la, los (pronombre)",artículo / pronombre,Le chat dort sur la chaise.,El gato duerme en la silla.
être,"ser, estar",verbo,Je suis ingénieur.,Soy ingeniero.
```

Si el CSV no trae ese encabezado (por ejemplo, solo `chat,gato`), la columna 1 es el frente y la 2 el reverso, y puedes reasignar las columnas antes de importar. Antes de importar ves una vista previa y eliges el mazo. Si un frente ya existe en el mazo, esa fila se omite.

## Respaldo

Todo vive solo en tu teléfono. En **Ajustes → Respaldo**:

- **Exportar JSON** descarga un archivo con mazos, tarjetas, progreso y ajustes. En el iPhone guárdalo en Archivos o iCloud Drive (o usa **Compartir respaldo…**).
- **Importar JSON** restaura ese archivo, ya sea reemplazando todo o combinándolo con lo que ya tienes.

La app te avisa si pasaron más de 14 días desde el último respaldo.

## Repaso espaciado

- Pasos de aprendizaje de 1 y 10 min. *Bien* en el último paso pasa la tarjeta a repaso a 1 día y *Fácil* a 4 días.
- En repaso, *Otra vez* resta 0,20 al ease y la manda a reaprendizaje (10 min) con el intervalo a la mitad (mínimo 1 día). *Difícil* multiplica el intervalo por 1,2 y resta 0,15 al ease. *Bien* lo multiplica por el ease, y *Fácil* por ease × 1,3 y suma 0,15 al ease. El ease empieza en 2,5 y no baja de 1,3.
- Los intervalos de más de 2 días llevan un fuzz de ±5 %. Además, cada botón da al menos un día más que el anterior.
- Por defecto son 10 nuevas y 200 repasos al día, y el día cambia a las 4:00 AM.

## Desarrollo

Son archivos estáticos (HTML, CSS y ES modules), sin build ni dependencias. Para probar en local, sirve la carpeta con cualquier servidor estático, por ejemplo `python3 -m http.server`. Las pruebas corren así:

```bash
node --test
```

Cuando cambies archivos, sube `VERSION` en `app.js` y `sw.js` para que el service worker renueve el caché. Una prueba verifica que las dos versiones coincidan.
