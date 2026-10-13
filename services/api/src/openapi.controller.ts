import { Controller, Get } from '@nestjs/common';
import { buildOpenApi } from './openapi.ts';

@Controller()
export class OpenApiController {
  /** No token: the description names routes and shapes, no data. */
  @Get('openapi.json')
  openapi(): Record<string, unknown> {
    return buildOpenApi();
  }
}
