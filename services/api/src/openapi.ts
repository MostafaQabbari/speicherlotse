import { CHANNELS, CHANNEL_NAMES } from '@speicherlotse/telemetry-model';
import { ALARM_EVENTS_LIMIT, TELEMETRY_LIMIT } from './limits.ts';

// The description of this API as OpenAPI 3.1, so that a client (the Angular dashboard) can be generated from it.
// It is written by hand because the routes validate their parameters by hand (params.ts). Three things keep it honest:
//  - the page sizes come from limits.ts, the same constants the routes use;
//  - openapi.test.ts lists the routes of the application and fails if one is missing here or one is documented that does not exist;
//  - the same test calls every route with a real database and checks each answer against the schemas below.
// `services/api/openapi.json` is this document written to a file (`pnpm --filter @speicherlotse/api openapi`); a test fails if it is stale.

const INT4_MAX = 2_147_483_647;
const JSON_TYPE = 'application/json';

const errorBody = { description: 'Error', content: { [JSON_TYPE]: { schema: { $ref: '#/components/schemas/Error' } } } };
const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });
const okBody = (name: string, description: string): object => ({ description, content: { [JSON_TYPE]: { schema: ref(name) } } });

const instantParam = (name: 'from' | 'to', side: string): object => ({
  name,
  in: 'query',
  required: false,
  description: `${side}. A date and time with a time zone, for example 2026-10-10T12:00:00Z. Years 2000 to 2100.`,
  schema: { type: 'string', format: 'date-time' },
});

const limitParam = (limit: { default: number; max: number }): object => ({
  name: 'limit',
  in: 'query',
  required: false,
  description: `How many rows at most, newest first. A larger number is refused, not cut.`,
  schema: { type: 'integer', minimum: 1, maximum: limit.max, default: limit.default },
});

const channelProperties = Object.fromEntries(
  CHANNEL_NAMES.map((name) => [name, { type: 'number', description: `${CHANNELS[name].doc} (${CHANNELS[name].unit})` }]));

export function buildOpenApi(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Speicherlotse API',
      version: '0.1.0',
      description: 'Read-only access to the devices, telemetry and alarm events of one tenant. The tenant is part of the token; the database enforces it (ADR-006). Development tokens only.',
    },
    servers: [{ url: 'http://127.0.0.1:3000', description: 'local development' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': {
        get: {
          operationId: 'getHealth',
          tags: ['health'],
          summary: 'Is the API up and can it reach its database?',
          security: [],
          responses: {
            '200': okBody('Health', 'Up'),
            '503': errorBody,
          },
        },
      },
      '/openapi.json': {
        get: {
          operationId: 'getOpenApi',
          tags: ['health'],
          summary: 'This description',
          security: [],
          responses: { '200': { description: 'The OpenAPI document', content: { [JSON_TYPE]: { schema: { type: 'object' } } } } },
        },
      },
      '/v1/devices': {
        get: {
          operationId: 'listDevices',
          tags: ['devices'],
          summary: 'The devices of the caller\'s tenant',
          responses: { '200': okBody('DevicesResponse', 'The devices'), '401': errorBody, '500': errorBody },
        },
      },
      '/v1/devices/{id}/telemetry': {
        get: {
          operationId: 'getDeviceTelemetry',
          tags: ['devices'],
          summary: 'Samples of one device, newest first',
          description: 'A device of another tenant and a device that does not exist give the same 404.',
          parameters: [
            { name: 'id', in: 'path', required: true, description: 'Device id', schema: { type: 'integer', minimum: 1, maximum: INT4_MAX } },
            instantParam('from', 'Oldest moment wanted (inclusive)'),
            instantParam('to', 'Newest moment wanted (exclusive); must be after from'),
            limitParam(TELEMETRY_LIMIT),
          ],
          responses: { '200': okBody('TelemetryResponse', 'The device and its samples'), '400': errorBody, '401': errorBody, '404': errorBody, '500': errorBody },
        },
      },
      '/v1/alarms/events': {
        get: {
          operationId: 'listAlarmEvents',
          tags: ['alarms'],
          summary: 'Alarm events (fired, resolved) of the caller\'s devices, newest first',
          description: 'With deviceId, a device of another tenant and a device that does not exist give the same 404.',
          parameters: [
            { name: 'deviceId', in: 'query', required: false, description: 'Only this device', schema: { type: 'integer', minimum: 1, maximum: INT4_MAX } },
            instantParam('from', 'Oldest moment wanted (inclusive)'),
            instantParam('to', 'Newest moment wanted (exclusive); must be after from'),
            limitParam(ALARM_EVENTS_LIMIT),
          ],
          responses: { '200': okBody('AlarmEventsResponse', 'The events'), '400': errorBody, '401': errorBody, '404': errorBody, '500': errorBody },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A development token: node services/api/src/token-cli.ts alpha' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['statusCode', 'error', 'message'],
          additionalProperties: false,
          properties: { statusCode: { type: 'integer' }, error: { type: 'string' }, message: { type: 'string' } },
        },
        Health: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['ok'] } },
        },
        Device: {
          type: 'object',
          required: ['deviceId', 'name'],
          additionalProperties: false,
          properties: { deviceId: { type: 'integer' }, name: { type: 'string' } },
        },
        DevicesResponse: {
          type: 'object',
          required: ['devices'],
          additionalProperties: false,
          properties: { devices: { type: 'array', items: ref('Device') } },
        },
        TelemetrySample: {
          type: 'object',
          required: ['ts', 'bootId', 'seq', 'monoMs', 'values'],
          additionalProperties: false,
          properties: {
            ts: { type: 'string', format: 'date-time', description: 'Time on the device clock, UTC' },
            bootId: { type: 'string', pattern: '^[0-9]+$', description: 'A whole number as text, because it can be larger than a JSON number holds exactly' },
            seq: { type: 'integer', description: 'Counts samples since the device booted' },
            monoMs: { type: 'integer', description: 'Milliseconds since the device booted' },
            values: {
              type: 'object',
              additionalProperties: false,
              description: 'The channels the device sent. A channel it did not send is left out.',
              properties: channelProperties,
            },
          },
        },
        TelemetryResponse: {
          type: 'object',
          required: ['device', 'samples'],
          additionalProperties: false,
          properties: { device: ref('Device'), samples: { type: 'array', items: ref('TelemetrySample') } },
        },
        AlarmEvent: {
          type: 'object',
          required: ['deviceId', 'ruleId', 'severity', 'event', 'at', 'atMs'],
          additionalProperties: false,
          properties: {
            deviceId: { type: 'integer' },
            ruleId: { type: 'string' },
            severity: { type: 'string', enum: ['warning', 'critical'] },
            event: { type: 'string', enum: ['fired', 'resolved'] },
            at: { type: 'string', format: 'date-time' },
            atMs: { type: 'integer', description: 'The same moment in milliseconds since 1970' },
          },
        },
        AlarmEventsResponse: {
          type: 'object',
          required: ['events'],
          additionalProperties: false,
          properties: { events: { type: 'array', items: ref('AlarmEvent') } },
        },
      },
    },
  };
}

/** The document as written to services/api/openapi.json. */
export const openApiText = (): string => `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
