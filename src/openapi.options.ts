import type { OpenApiOptions } from '@darmawanweb/ais-its-nest';

import { SERVICE } from './service.js';

/** OpenAPI document of the service (`/docs`, `/openapi.json`, `pnpm openapi`). */
export const OPENAPI: OpenApiOptions = {
  title: `AIS Maritime Intelligence — ${SERVICE.title}`,
  version: SERVICE.version,
  description: SERVICE.description,
  tags: [
    {
      name: 'zones',
      description:
        'Zones and geofences: global zones and organization zones, GeoJSON in WGS84, map layer, GEO stream republication',
    },
    {
      name: 'methodology',
      description: 'Methods of the methodology catalog implemented here',
    },
  ],
};
