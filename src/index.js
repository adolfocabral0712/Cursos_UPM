const CURSO = 'Normas Transportistas madera no pulpable';

const normal = valor => String(valor ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

function ci(valor) {
  if (
    valor == null ||
    typeof valor === 'boolean' ||
    (typeof valor === 'number' && !Number.isInteger(valor))
  ) {
    return '';
  }

  return String(valor)
    .replace(/\D/g, '')
    .replace(/^0+/, '');
}

function json(datos, status = 200) {
  return new Response(JSON.stringify(datos), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function fecha(valor) {
  const texto = normal(valor);

  let coincidencia =
    /^(\d{4})-(\d{2})-(\d{2})(?:$|[t ])/i.exec(texto);

  let anio;
  let mes;
  let dia;

  if (coincidencia) {
    [, anio, mes, dia] = coincidencia;
  } else {
    coincidencia =
      /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:$|\s)/.exec(texto);

    if (coincidencia) {
      [, dia, mes, anio] = coincidencia;
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

      coincidencia =
        /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(texto);

      if (
        !coincidencia ||
        !meses[coincidencia[1].slice(0, 3)]
      ) {
        return null;
      }

      mes = meses[coincidencia[1].slice(0, 3)];
      dia = coincidencia[2];
      anio = coincidencia[3];
    }
  }

  const resultado = new Date(Date.UTC(
    Number(anio),
    Number(mes) - 1,
    Number(dia)
  ));

  if (
    resultado.getUTCFullYear() !== Number(anio) ||
    resultado.getUTCMonth() !== Number(mes) - 1 ||
    resultado.getUTCDate() !== Number(dia)
  ) {
    return null;
  }

  return resultado;
}

function enriquecer(registro, cedulas) {
  const documento = ci(registro.ci);
  const aprobacion = fecha(registro.fecha_aprobacion);

  const plazo = /^(\d+)\s*dias?$/.exec(
    normal(registro.validez)
  );

  const vencimiento = aprobacion && plazo
    ? new Date(
        aprobacion.getTime() +
        Number(plazo[1]) * 86400000
      )
    : null;

  return {
    ...registro,
    ci: documento,
    'EN FLOTA ACTUAL': cedulas.has(documento) ? 'SI' : 'NO',
    fecha_vencimiento:
      vencimiento && Number.isFinite(vencimiento.getTime())
        ? vencimiento.toISOString().slice(0, 10)
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

  function recorrer(valor) {
    if (Array.isArray(valor)) {
      valor.forEach(recorrer);
    } else if (valor && typeof valor === 'object') {
      for (const [clave, dato] of Object.entries(valor)) {
        if (normal(clave) === 'cedula_identidad') {
          const documento = ci(dato);

          if (documento) {
            cedulas.add(documento);
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
    .filter(registro =>
      registro &&
      normal(registro.curso).includes(normal(CURSO)) &&
      ci(registro.ci)
    )
    .map(registro => enriquecer(registro, cedulas));

  if (!registros.length) {
    throw new Error(
      'No se encontraron registros de Normas Transportistas en el archivo de cursos.'
    );
  }

  const grupos = new Map();

  for (const registro of registros) {
    if (!cedulas.has(registro.ci)) {
      continue;
    }

    if (!grupos.has(registro.ci)) {
      grupos.set(registro.ci, []);
    }

    grupos.get(registro.ci).push(registro);
  }

  const flotaActual = [...cedulas].sort().map(documento => {
    const historial = grupos.get(documento) || [];

    const elegido = historial.reduce((anterior, siguiente) => {
      if (!anterior) {
        return siguiente;
      }

      const fechaAnterior =
        fecha(anterior.fecha_aprobacion)?.getTime() ?? 0;

      const fechaSiguiente =
        fecha(siguiente.fecha_aprobacion)?.getTime() ?? 0;

      return fechaSiguiente > fechaAnterior
        ? siguiente
        : anterior;
    }, null);

    const faltante = {
      ci: documento,
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

    // Fecha informada por el JSON de cursos.
    actualizado: cursos.actualizado ?? null,

    // Fecha de carga informada por el JSON de camiones.
    // Si no existe, utiliza el campo actualizado.
    actualizado_flota:
      carga.fechaCarga ?? carga.actualizado ?? null,

    // Momento en que Cloudflare consultó ambas fuentes.
    flota_consultada: new Date().toISOString(),

    cantidad_registros: registros.length,
    cantidad_choferes_flota: cedulas.size,
    registros,
    flota_actual: flotaActual
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
        // Descarga ambos archivos en cada consulta.
        const [cursos, carga] = await Promise.all([
          descargar(
            env.CURSOS_FAS_JSON_URL,
            'cursos'
          ),
          descargar(
            env.CARGA_CAMIONES_JSON_URL,
            'carga de camiones'
          )
        ]);

        return json(cruzar(cursos, carga));
      } catch (error) {
        return json({
          error: error.message
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
