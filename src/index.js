const CURSO = 'Normas Transportistas madera no pulpable';

const normal = v => String(v ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

function ci(v) {
  if (
    v == null ||
    typeof v === 'boolean' ||
    (typeof v === 'number' && !Number.isInteger(v))
  ) {
    return '';
  }

  return String(v)
    .replace(/\D/g, '')
    .replace(/^0+/, '');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function fecha(valor) {
  const s = normal(valor);

  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[t ])/i.exec(s);
  let y;
  let mes;
  let d;

  if (m) {
    [, y, mes, d] = m;
  } else {
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:$|\s)/.exec(s);

    if (m) {
      [, d, mes, y] = m;
    } else {
      const meses = {
        ene: 1,
        jan: 1,
        feb: 2,
        mar: 3,
        abr: 4,
        apr: 4,
        may: 5,
        jun: 6,
        jul: 7,
        ago: 8,
        aug: 8,
        sep: 9,
        set: 9,
        oct: 10,
        nov: 11,
        dic: 12,
        dec: 12
      };

      m = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);

      if (!m || !meses[m[1].slice(0, 3)]) {
        return null;
      }

      mes = meses[m[1].slice(0, 3)];
      d = m[2];
      y = m[3];
    }
  }

  const f = new Date(Date.UTC(
    Number(y),
    Number(mes) - 1,
    Number(d)
  ));

  return (
    f.getUTCFullYear() === Number(y) &&
    f.getUTCMonth() === Number(mes) - 1 &&
    f.getUTCDate() === Number(d)
  ) ? f : null;
}

function enriquecer(r, cedulas) {
  const id = ci(r.ci);
  const aprobacion = fecha(r.fecha_aprobacion);
  const plazo = /^(\d+)\s*dias?$/.exec(normal(r.validez));

  const fin = aprobacion && plazo
    ? new Date(
        aprobacion.getTime() + Number(plazo[1]) * 86400000
      )
    : null;

  return {
    ...r,
    ci: id,
    'EN FLOTA ACTUAL': cedulas.has(id) ? 'SI' : 'NO',
    fecha_vencimiento:
      fin && Number.isFinite(fin.getTime())
        ? fin.toISOString().slice(0, 10)
        : null
  };
}

function cruzar(cursos, carga) {
  const filas = Array.isArray(cursos)
    ? cursos
    : cursos?.registros;

  if (!Array.isArray(filas) || !filas.length) {
    throw new Error(
      'El archivo de cursos no contiene registros utilizables.'
    );
  }

  const cedulas = new Set();

  function recorrer(v) {
    if (Array.isArray(v)) {
      v.forEach(recorrer);
    } else if (v && typeof v === 'object') {
      for (const [k, dato] of Object.entries(v)) {
        if (normal(k) === 'cedula_identidad') {
          const id = ci(dato);

          if (id) {
            cedulas.add(id);
          }
        } else if (dato && typeof dato === 'object') {
          recorrer(dato);
        }
      }
    }
  }

  recorrer(carga);

  if (!cedulas.size) {
    throw new Error(
      'El archivo de carga no contiene cédulas utilizables en cedula_identidad.'
    );
  }

  const registros = filas
    .filter(r =>
      r &&
      normal(r.curso).includes(normal(CURSO)) &&
      ci(r.ci)
    )
    .map(r => enriquecer(r, cedulas));

  if (!registros.length) {
    throw new Error(
      'No se encontraron registros de Normas Transportistas en el archivo de cursos.'
    );
  }

  const grupos = new Map();

  for (const r of registros) {
    if (cedulas.has(r.ci)) {
      if (!grupos.has(r.ci)) {
        grupos.set(r.ci, []);
      }

      grupos.get(r.ci).push(r);
    }
  }

  const flota_actual = [...cedulas].sort().map(id => {
    const historial = grupos.get(id) || [];

    const elegido = historial.reduce((a, b) => {
      if (!a) return b;

      const fechaB = fecha(b.fecha_aprobacion)?.getTime() ?? 0;
      const fechaA = fecha(a.fecha_aprobacion)?.getTime() ?? 0;

      return fechaB > fechaA ? b : a;
    }, null);

    const faltante = {
      ci: id,
      nombre: '',
      contratista: '',
      curso: CURSO,
      estado: 'Sin curso registrado',
      fecha_aprobacion: '',
      validez: '',
      fecha_vencimiento: null
    };

    return {
      ...(elegido || faltante),
      'EN FLOTA ACTUAL': 'SI',
      cantidad_registros_curso: historial.length,
      historial
    };
  });

  return {
    version_esquema: 2,
    curso: registros[0].curso,
    actualizado: cursos.actualizado ?? null,
    actualizado_flota: carga.actualizado ?? null,
    flota_consultada: new Date().toISOString(),
    cantidad_registros: registros.length,
    cantidad_choferes_flota: cedulas.size,
    registros,
    flota_actual
  };
}

async function descargar(valor, etiqueta) {
  let url;

  try {
    url = new URL(valor.trim());

    if (url.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new Error(
      `El secreto de ${etiqueta} debe contener una URL HTTPS válida.`
    );
  }

  url.searchParams.set('_', Date.now().toString());

  let respuesta;

  try {
    respuesta = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(45000),
      cf: {
        cacheTtl: 0,
        cacheEverything: false
      }
    });
  } catch {
    throw new Error(
      `No se pudo consultar la fuente de ${etiqueta}.`
    );
  }

  if (!respuesta.ok) {
    throw new Error(
      `La fuente de ${etiqueta} no respondió correctamente.`
    );
  }

  try {
    return await respuesta.json();
  } catch {
    throw new Error(
      `La fuente de ${etiqueta} no devolvió un JSON válido.`
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/cursos') {
      if (request.method !== 'GET') {
        return new Response('Método no permitido', {
          status: 405,
          headers: {
            Allow: 'GET'
          }
        });
      }

      for (const clave of [
        'CURSOS_FAS_JSON_URL',
        'CARGA_CAMIONES_JSON_URL'
      ]) {
        if (!env[clave]) {
          return json({
            error: `Falta el secreto ${clave}.`
          }, 503);
        }
      }

      try {
        const [cursos, carga] = await Promise.all([
          descargar(env.CURSOS_FAS_JSON_URL, 'cursos'),
          descargar(
            env.CARGA_CAMIONES_JSON_URL,
            'carga de camiones'
          )
        ]);

        return json(cruzar(cursos, carga));
      } catch (e) {
        return json({
          error: e.message
        }, 502);
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return json({
        error: 'Ruta no encontrada.'
      }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
