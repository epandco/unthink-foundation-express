import { MiddlewareType } from '@epandco/unthink-foundation/lib/core';
import { RequestHandler } from 'express';
import { ExpressMiddleware } from './unthink-express-generator';


export function expressMiddleware(handler: RequestHandler): ExpressMiddleware {
  const expressHandler = handler as ExpressMiddleware;
  expressHandler.__expressMiddleware = 'EXPRESS_MIDDLEWARE';
  expressHandler.__middlewareType = MiddlewareType.RAW;

  return expressHandler;
}
