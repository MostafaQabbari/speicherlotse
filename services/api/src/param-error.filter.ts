import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ParamError } from './params.ts';

/** A parameter the caller got wrong is the caller's problem: 400 with the reason, in the same shape Nest uses for its own errors. */
@Catch(ParamError)
export class ParamErrorFilter implements ExceptionFilter {
  catch(error: ParamError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(400).json({ statusCode: 400, error: 'Bad Request', message: error.message });
  }
}
